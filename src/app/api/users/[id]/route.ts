import { Group, Prisma } from "@prisma/client";
import authOptions from "lib/auth";

import { prisma } from "lib/prisma";
import ResponseDTO from "lib/response";
import { getServerSession } from "next-auth";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return ResponseDTO.status(401).json({
      result: false,
      error: {
        title: "Unauthorized",
        message: "You are not authorized to perform this action",
      },
    });
  }

  const user = await prisma.user.findUnique({
    where: {
      id: session.user.id,
    },
    include: {
      groups: true,
    },
  });

  if (!user || !user.groups.find((g) => g.name === "Admin")) {
    return ResponseDTO.status(403).json({
      result: false,
      error: {
        title: "Forbidden",
        message: "You are not authorized to perform this action",
      },
    });
  }

  const userId = req.url.split("/").pop();

  const { memo, groups } = await req.json();

  const targetUser = await prisma.user.findUnique({
    where: {
      id: userId,
    },
  });

  if (!targetUser) {
    return ResponseDTO.status(404).json({
      result: false,
      error: {
        title: "Not Found",
        message: "User not found",
      },
    });
  }

  await prisma.user.update({
    where: {
      id: userId,
    },
    data: {
      memo,
    },
  });

  await prisma.user.update({
    where: {
      id: userId,
    },
    data: {
      groups: {
        set: groups.map((g: Group) => ({ id: g.id })),
      },
    },
  });

  return ResponseDTO.status(201).json({
    result: true,
  });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return ResponseDTO.status(401).json({
      result: false,
      error: {
        title: "Unauthorized",
        message: "You are not authorized to perform this action",
      },
    });
  }

  const user = await prisma.user.findUnique({
    where: {
      id: session.user.id,
    },
    include: {
      groups: true,
    },
  });

  if (!user || !user.groups.find((g) => g.name === "Admin")) {
    return ResponseDTO.status(403).json({
      result: false,
      error: {
        title: "Forbidden",
        message: "You are not authorized to perform this action",
      },
    });
  }

  const userId = req.url.split("/").pop();

  const targetUser = await prisma.user.findUnique({
    where: {
      id: userId,
    },
  });

  if (!targetUser) {
    return ResponseDTO.status(404).json({
      result: false,
      error: {
        title: "Not Found",
        message: "User not found",
      },
    });
  }

  try {
    await prisma.user.delete({
      where: {
        id: userId,
      },
    });
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2003"
    ) {
      return ResponseDTO.status(409).json({
        result: false,
        error: {
          title: "Conflict",
          message: "User has certificate logs and cannot be deleted",
        },
      });
    }

    throw e;
  }

  return ResponseDTO.status(200).json({
    result: true,
  });
}
