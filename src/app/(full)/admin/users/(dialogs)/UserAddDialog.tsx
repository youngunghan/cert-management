"use client";

import { FormEvent, useState } from "react";

import { useRouter } from "next/navigation";

import { Group } from "@prisma/client";

import validator from "validator";

import IconDown from "assets/icons/icon_down.svg";
import IconUp from "assets/icons/icon_up.svg";

type DialogProps = {
  open: boolean;
  onClose: () => void;
  groups: Group[];
};

export default function UserAddDialog({ open, onClose, groups }: DialogProps) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [googleId, setGoogleId] = useState("");
  const [userGroups, setUserGroups] = useState<Group[]>([]);

  const [loading, setLoading] = useState(false);

  const clear = () => {
    setName("");
    setEmail("");
    setGoogleId("");
    setUserGroups([]);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!name.trim() || !validator.isEmail(email)) {
      return;
    }

    setLoading(true);

    const response = await fetch("/api/users", {
      method: "POST",
      credentials: "include",
      body: JSON.stringify({
        name,
        email,
        googleId: googleId.trim() ? googleId : null,
        groups: userGroups,
      }),
    });

    setLoading(false);

    if (!response.ok) {
      const { error } = await response.json().catch(() => ({ error: null }));
      alert(error?.message ?? "사용자 추가에 실패했습니다.");
      return;
    }

    clear();
    onClose();

    router.refresh();
  };

  if (!open) {
    return null;
  }

  return (
    <div className="z-10 fixed flex justify-center items-center top-0 left-0 w-full h-screen bg-black bg-opacity-50">
      <form
        className="w-full max-w-sm m-3 bg-white rounded-lg shadow-lg p-6"
        onSubmit={onSubmit}
      >
        <h2 className="text-2xl font-semibold">사용자 추가</h2>
        <div className="mt-3">
          <p className="font-semibold">
            이름<span className="text-red-500">*</span>
          </p>
          <input
            type="text"
            placeholder="이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border-gray-300 border p-2 w-full"
          />
        </div>
        <div className="mt-3">
          <p className="font-semibold">
            이메일<span className="text-red-500">*</span>
          </p>
          <input
            type="text"
            placeholder="이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border-gray-300 border p-2 w-full"
          />
        </div>
        <div className="mt-3">
          <p className="font-semibold">Google ID</p>
          <input
            type="text"
            placeholder="Google ID"
            value={googleId}
            onChange={(e) => setGoogleId(e.target.value)}
            className="rounded-md border-gray-300 border p-2 w-full"
          />
        </div>
        <div className="mt-3">
          <p className="font-semibold">유저 그룹</p>
          <p className="font-medium">전체 그룹</p>
          {groups
            .filter((g) => !userGroups.includes(g))
            .map((group) => (
              <div
                key={group.id}
                className="border border-gray-200 p-2"
                onClick={() => setUserGroups([...userGroups, group])}
                onKeyDown={() => setUserGroups([...userGroups, group])}
              >
                {group.name}
              </div>
            ))}
          <div className="flex justify-center my-3">
            <IconUp className="w-5 h-5" />
            <IconDown className="w-5 h-5" />
          </div>
          <p className="font-medium">유저 그룹</p>
          {userGroups.map((group) => (
            <div
              key={group.id}
              className="border border-gray-200 p-2"
              onClick={() =>
                setUserGroups(userGroups.filter((g) => g !== group))
              }
              onKeyDown={() =>
                setUserGroups(userGroups.filter((g) => g !== group))
              }
            >
              {group.name}
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="px-4 py-2 bg-gray-200 rounded-md disabled:opacity-50"
            onClick={() => {
              clear();
              onClose();
            }}
            disabled={loading}
          >
            취소
          </button>
          <div className="w-3" />
          <button
            type="submit"
            disabled={!name || !validator.isEmail(email) || loading}
            className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50"
          >
            추가
          </button>
        </div>
      </form>
    </div>
  );
}
