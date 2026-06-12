"use client";

import { useState } from "react";

import { Group } from "@prisma/client";

import IconClose from "assets/icons/icon_close.svg";
import { useRouter } from "next/navigation";
import { StringParam, useQueryParam } from "use-query-params";

type ContentProps = {
  group: Group;
  onClose: () => void;
};

function GroupInfoContent({ group, onClose }: ContentProps) {
  const router = useRouter();

  const [loading, setLoading] = useState(false);

  const onDelete = async () => {
    setLoading(true);

    const response = await fetch(`/api/groups/${group.id}`, {
      method: "DELETE",
      credentials: "include",
    });

    setLoading(false);

    if (!response.ok) {
      const { error } = await response.json().catch(() => ({ error: null }));
      alert(error?.message ?? "사용자 그룹 삭제에 실패했습니다.");
      return;
    }

    onClose();
    router.refresh();
  };

  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex items-center">
        <IconClose className="w-6 h-6 cursor-pointer mr-3" onClick={onClose} />
        <p className="text-2xl font-bold">{group.name}</p>
      </div>
      <div className="mt-3" />
      <div className="mt-3">
        <p className="font-semibold">그룹 ID</p>
        <p className="text-gray-800 overflow-hidden text-ellipsis">
          {group.id}
        </p>
      </div>
      <div className="flex-1" />
      <div className="w-full flex justify-end">
        <button
          type="button"
          className="px-4 py-2 bg-red-500 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={group.name === "Admin" || loading}
          onClick={onDelete}
        >
          삭제
        </button>
      </div>
    </div>
  );
}

type Props = {
  groups: Group[];
};

export default function GroupInfo({ groups }: Props) {
  const [groupId, setGroupId] = useQueryParam("group", StringParam);

  if (!groupId || !groupId.trim()) {
    return null;
  }

  const group = groups.find((group) => group.id === groupId);
  if (!group) {
    return null;
  }

  return (
    <div
      className="z-10 bg-black bg-opacity-50 fixed top-0 left-0 w-full h-screen"
      onClick={() => setGroupId(undefined)}
      onKeyDown={() => setGroupId(undefined)}
    >
      <div
        className="absolute right-0 w-full md:w-1/2 xl:w-1/3 h-screen overflow-y-auto bg-white z-20 p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <GroupInfoContent group={group} onClose={() => setGroupId(undefined)} />
      </div>
    </div>
  );
}
