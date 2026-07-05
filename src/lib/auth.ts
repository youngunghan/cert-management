import { AuthOptions, getServerSession } from "next-auth";
import GoogleProvider, { GoogleProfile } from "next-auth/providers/google";

import { redirect } from "next/navigation";
import { prisma } from "./prisma";

const authOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === "google") {
        const googleProfile = profile as GoogleProfile;
        const googleId = googleProfile.sub;

        // SECURITY: reject unverified Google emails. Email is the account-linking
        // key below, so accepting an unverified email enables account takeover.
        if (!googleProfile.email_verified) {
          return false;
        }

        if (
          process.env.DEFAULT_ADMIN_EMAIL &&
          googleProfile.email === process.env.DEFAULT_ADMIN_EMAIL
        ) {
          let adminGroup = await prisma.group.findUnique({
            where: { name: "Admin" },
          });

          if (!adminGroup) {
            adminGroup = await prisma.group.create({
              data: {
                name: "Admin",
              },
            });
          }

          const adminUser = await prisma.user.findUnique({
            where: {
              email: process.env.DEFAULT_ADMIN_EMAIL,
            },
          });

          if (!adminUser) {
            await prisma.user.create({
              data: {
                name: googleProfile.name,
                email: googleProfile.email,
                googleId,
                memo: "Default admin user",
                groups: {
                  connect: adminGroup,
                },
              },
            });
          }

          return true;
        }

        const databaseUser = await prisma.user.findUnique({
          where: {
            email: googleProfile.email,
          },
        });

        if (!databaseUser) {
          return "/unregistered";
        }

        // SECURITY: only bind googleId on first sign-in. If an account already
        // has a googleId and the incoming sub differs, refuse — otherwise another
        // Google account sharing this email could overwrite the binding (takeover).
        if (databaseUser.googleId && databaseUser.googleId !== googleId) {
          return false;
        }

        if (!databaseUser.googleId) {
          await prisma.user.update({
            where: {
              id: databaseUser.id,
            },
            data: {
              googleId,
            },
          });
        }

        return true;
      }

      return false;
    },
    async session({ session, token }) {
      if (token) {
        session.user = {
          id: token.id,
          name: token.name,
          googleId: token.googleId,
        };
      }
      return session;
    },
    async jwt({ token, user }) {
      if (user) {
        const databaseUser = await prisma.user.findUnique({
          where: {
            googleId: user.id,
          },
        });

        if (!databaseUser) {
          return token;
        }

        token = {
          ...token,
          id: databaseUser.id,
          name: databaseUser.name,
          googleId: user.id,
        };
      }
      return token;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
} satisfies AuthOptions;

export default authOptions;

export async function withAuth(allowUnregistered = false) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect(`${process.env.BASE_URL}/login`);
  }

  const user = await prisma.user.findUnique({
    where: {
      id: session.user.id,
    },
    include: {
      groups: true,
    },
  });

  if (!user && !allowUnregistered) {
    redirect(`${process.env.BASE_URL}/unregistered`);
  }

  return user;
}
