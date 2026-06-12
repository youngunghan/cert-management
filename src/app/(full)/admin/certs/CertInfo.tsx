"use client";
import { useState } from "react";

import { Certificate, User } from "@prisma/client";
import { StringParam, useQueryParam } from "use-query-params";

import CertPreview from "components/CertPreview";
import Pagination from "components/Pagination";

import IconClose from "assets/icons/icon_close.svg";

type ContentProps = {
  cert: Certificate;
  users: User[];
  onClose: () => void;
};

type CertContent = {
  image: {
    data: string;
    width: number;
    height: number;
    left: number;
    top: number;
  };
  texts: {
    data: string;
    scale: number;
    left: number;
    top: number;
  }[];
  rects: {
    width: number;
    height: number;
    left: number;
    top: number;
  }[];
  orientation: "landscape" | "portrait";
};

function CertInfoContent({ cert, users, onClose }: ContentProps) {
  const [userPage, setUserPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const deleteCert = async () => {
    if (!confirm("정말 삭제하시겠습니까?")) {
      return;
    }

    setLoading(true);

    const response = await fetch(`/api/certs/${cert.id}`, {
      method: "DELETE",
    });

    setLoading(false);

    if (response.ok) {
      onClose();
    } else {
      const { error } = await response.json().catch(() => ({ error: null }));
      alert(error?.message ?? "증명서 삭제에 실패했습니다.");
    }
  };

  return (
    <>
      <div className="flex items-center">
        <IconClose className="w-6 h-6 cursor-pointer mr-3" onClick={onClose} />
        <h3 className="text-2xl font-bold">증명서</h3>
      </div>
      <div className="mt-3">
        <h4 className="text-lg font-semibold">이름</h4>
        <p>{cert.name}</p>
      </div>
      <div className="mt-3">
        <h4 className="text-lg font-semibold">발급 대상</h4>
        <div>
          {users
            .map((user) => (
              <div
                key={user.id}
                className="flex items-center p-2 border-b border-b-gray-100 last-of-type:border-b-0"
              >
                <p>
                  {user.name} ({user.email})
                </p>
              </div>
            ))
            .slice((userPage - 1) * 10, userPage * 10)}
        </div>
        <div className="w-full flex justify-center mt-3">
          <Pagination
            page={userPage}
            setPage={setUserPage}
            total={users.length}
          />
        </div>
      </div>
      <div className="mt-3">
        <h4 className="text-lg font-semibold">미리보기</h4>
        <CertPreview content={cert.content} />
      </div>
      <div className="flex-1" />
      <div className="flex justify-end">
        <button
          type="button"
          className="px-4 py-2 bg-gray-200 focus:bg-gray-300 rounded-md mr-3"
          disabled={loading}
          onClick={onClose}
        >
          취소
        </button>
        <div className="w-3 h-3" />
        <button
          type="button"
          className="px-4 py-2 bg-red-500 focus:bg-red-600 text-white rounded-md"
          disabled={loading}
          onClick={deleteCert}
        >
          삭제
        </button>
      </div>
    </>
  );
}

type Props = {
  users: User[];
  certs: Certificate[];
};

export default function CertInfo({ users, certs }: Props) {
  const [certId, setCertId] = useQueryParam("cert", StringParam);

  if (!certId || !certId.trim()) {
    return null;
  }

  const cert = certs.find((cert) => cert.id === certId);
  if (!cert) {
    return null;
  }

  const certUser = users.filter((user) => cert.userIds.includes(user.id));

  return (
    <div
      className="z-10 bg-black bg-opacity-50 fixed top-0 left-0 w-full h-screen cursor-default"
      onClick={() => setCertId(undefined)}
      onKeyDown={() => setCertId(undefined)}
    >
      <div
        className="absolute top-1/2 h-[50vh] right-0 w-full md:h-screen md:top-0 md:w-1/2 xl:w-1/3 overflow-y-auto bg-white z-20 p-6 flex flex-col pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <CertInfoContent
          cert={cert}
          users={certUser}
          onClose={() => setCertId(undefined)}
        />
      </div>
    </div>
  );
}
