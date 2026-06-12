"use client";

import { useState } from "react";

import { Group, User } from "@prisma/client";

import IconClose from "assets/icons/icon_close.svg";
import { useRouter } from "next/navigation";
import { StringParam, useQueryParam } from "use-query-params";

type ContentProps = {
  user: User & {
    groups: Group[];
  };
  groups: Group[];
  onlyAdmin: boolean;
  onClose: () => void;
};

function UserInfoContent({ user, groups, onlyAdmin, onClose }: ContentProps) {
  const router = useRouter();

  const [memo, setMemo] = useState(user.memo);
  const [userGroups, setUserGroups] = useState(user.groups);

  const [loading, setLoading] = useState(false);

  const onDelete = async () => {
    setLoading(true);

    const response = await fetch(`/api/users/${user.id}`, {
      method: "DELETE",
      credentials: "include",
    });

    setLoading(false);

    if (!response.ok) {
      const { error } = await response.json().catch(() => ({ error: null }));
      alert(error?.message ?? "사용자 삭제에 실패했습니다.");
      return;
    }

    onClose();
    router.refresh();
  };

  const onSubmit = async () => {
    setLoading(true);

    const response = await fetch(`/api/users/${user.id}`, {
      method: "POST",
      credentials: "include",
      body: JSON.stringify({
        memo,
        groups: userGroups,
      }),
    });

    setLoading(false);

    if (!response.ok) {
      const { error } = await response.json().catch(() => ({ error: null }));
      alert(error?.message ?? "사용자 수정에 실패했습니다.");
    }
  };

  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex items-center">
        <IconClose className="w-6 h-6 cursor-pointer mr-3" onClick={onClose} />
        <p className="text-2xl font-bold">{user.name}</p>
      </div>
      <div className="mt-3" />
      <div className="mt-3">
        <p className="font-semibold">Google ID</p>
        <p className="text-gray-800 overflow-hidden text-ellipsis">
          {user.googleId}
        </p>
      </div>
      <div className="mt-3">
        <p className="font-semibold">이메일</p>
        <p className="text-gray-800">{user.email}</p>
      </div>
      <div className="mt-3">
        <p className="font-semibold">유저 그룹</p>
        <div className="flex">
          <div className="flex-1">
            <p className="font-medium">그룹 리스트</p>
            {groups
              .filter((g) => !userGroups.map((g) => g.id).includes(g.id))
              .map((group) => (
                <p
                  key={group.id}
                  className="text-gray-800 p-2 border border-gray-200 cursor-pointer"
                  onClick={() => setUserGroups([...userGroups, group])}
                  onKeyDown={() => setUserGroups([...userGroups, group])}
                >
                  {group.name}
                </p>
              ))}
          </div>
          <div className="w-6" />
          <div className="flex-1">
            <p className="font-medium">유저 그룹 리스트</p>
            {userGroups.map((group) => (
              <p
                key={group.id}
                className={`text-gray-800  p-2 border border-gray-200 ${
                  onlyAdmin && group.name === "Admin"
                    ? "cursor-not-allowed"
                    : "cursor-pointer"
                }`}
                onClick={() =>
                  onlyAdmin && group.name === "Admin"
                    ? undefined
                    : setUserGroups(userGroups.filter((g) => g !== group))
                }
                onKeyDown={() =>
                  onlyAdmin && group.name === "Admin"
                    ? undefined
                    : setUserGroups(userGroups.filter((g) => g !== group))
                }
              >
                {group.name}
              </p>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3">
        <p className="font-semibold">메모</p>
        <textarea
          className="w-full max-w-full min-w-full min-h-[300px] p-3 border border-gray-300 rounded-md focus:outline-none active:outline-none"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />
      </div>
      <div className="flex-1" />
      <div className="w-full flex justify-end">
        <button
          type="button"
          className="px-4 py-2 bg-red-500 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={
            (user.groups.find((g) => g.name === "Admin") && onlyAdmin) ||
            loading
          }
          onClick={onDelete}
        >
          삭제
        </button>
        <div className="w-6" />
        <button
          type="button"
          className="px-4 py-2 bg-blue-500 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={
            (memo === user.memo && userGroups === user.groups) || loading
          }
          onClick={onSubmit}
        >
          수정
        </button>
      </div>
    </div>
  );
}

type Props = {
  users: (User & {
    groups: Group[];
  })[];
  groups: Group[];
};

export default function UserInfo({ users, groups }: Props) {
  const [userId, setUserId] = useQueryParam("user", StringParam);

  if (!userId || !userId.trim()) {
    return null;
  }

  const user = users.find((user) => user.id === userId);
  if (!user) {
    return null;
  }

  const onlyAdmin =
    users.filter((user) => user.groups.find((g) => g.name === "Admin"))
      .length === 1;

  return (
    <div
      className="z-10 bg-black bg-opacity-50 fixed top-0 left-0 w-full h-screen"
      onClick={() => setUserId(undefined)}
      onKeyDown={() => setUserId(undefined)}
    >
      <div
        className="absolute right-0 w-full md:w-1/2 xl:w-1/3 h-screen overflow-y-auto bg-white z-20 p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <UserInfoContent
          user={user}
          groups={groups}
          onlyAdmin={onlyAdmin}
          onClose={() => setUserId(undefined)}
        />
      </div>
    </div>
  );
}
