"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
};

export default function GroupAddDialog({ open, onClose }: Props) {
  const router = useRouter();

  const [name, setName] = useState("");

  const [loading, setLoading] = useState(false);

  if (!open) {
    return null;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      return;
    }

    setLoading(true);

    const response = await fetch("/api/groups", {
      method: "POST",
      credentials: "include",
      body: JSON.stringify({
        name,
      }),
    });

    setLoading(false);

    if (!response.ok) {
      const { error } = await response.json().catch(() => ({ error: null }));
      alert(error?.message ?? "사용자 그룹 추가에 실패했습니다.");
      return;
    }

    setName("");
    onClose();

    router.refresh();
  };

  return (
    <div className="z-10 fixed flex justify-center items-center top-0 left-0 w-full h-screen bg-black bg-opacity-50">
      <form
        className="w-full max-w-sm m-3 bg-white rounded-lg shadow-lg p-6"
        onSubmit={onSubmit}
      >
        <h2 className="text-2xl font-semibold">사용자 그룹 추가</h2>
        <div className="mt-3">
          <p className="font-semibold">
            그룹 이름<span className="text-red-500">*</span>
          </p>
          <input
            type="text"
            placeholder="그룹 이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border-gray-300 border p-2 w-full"
          />
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="px-4 py-2 bg-gray-200 rounded-md disabled:opacity-50"
            onClick={() => {
              setName("");
              onClose();
            }}
            disabled={loading}
          >
            취소
          </button>
          <div className="w-3" />
          <button
            type="submit"
            disabled={!name || loading}
            className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50"
          >
            추가
          </button>
        </div>
      </form>
    </div>
  );
}
