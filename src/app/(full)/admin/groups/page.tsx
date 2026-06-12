import { redirect } from "next/navigation";

import { withAuth } from "lib/auth";
import { prisma } from "lib/prisma";

import Header from "../Header";
import GroupAdd from "./GroupAdd";
import Providers from "./Providers";
import Table from "./Table";
import GroupInfo from "./GroupInfo";

export const metadata = {
  title: "관리자 | OUTTA 증명서 발급센터",
  description: "관리자 | OUTTA 증명서 발급센터",
};

export default async function AdminGroupPage() {
  const user = await withAuth();

  if (!user || !user.groups.find((g) => g.name === "Admin")) {
    redirect(process.env.BASE_URL);
  }

  const groups = await prisma.group.findMany();

  return (
    <Providers>
      <main className="container mx-auto">
        <Header />
        <section className="mt-6 p-6">
          <a className="flex items-center" href="/admin/groups">
            <h2 className="text-2xl font-semibold">사용자 그룹</h2>
          </a>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-x-6">
            <div className="p-6 rounded-lg shadow-lg">
              <h3 className="text-xl font-semibold">등록된 그룹</h3>
              <p className="mt-3 text-4xl">{groups.length}개</p>
            </div>
          </div>
        </section>
        <section className="mt-6 px-6 flex justify-end">
          <GroupAdd />
        </section>
        <section className="mt-6 p-6">
          <Table groups={groups} />
        </section>
      </main>
      <GroupInfo groups={groups} />
    </Providers>
  );
}
