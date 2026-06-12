"use client";

import { useRef, useState } from "react";

import { Group, User } from "@prisma/client";

import { Canvas, Image, Rect, Text } from "fabric";

import CanvasForm, { CanvasData } from "./(forms)/CanvasForm";
import FileForm from "./(forms)/FileForm";
import UserForm from "./(forms)/UserForm";

type Props = {
  users: (User & { groups: Group[] })[];
};

export default function Form({ users }: Props) {
  const fabricRef = useRef<Canvas>();

  const [file, setFile] = useState<File | null>(null);
  const [canvasData, setCanvasData] = useState<CanvasData[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<
    (User & { groups: Group[] })[]
  >([]);

  const [orientation, setOrientation] = useState<"landscape" | "portrait">(
    "portrait"
  );

  const [name, setName] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);

  const canvasState = {
    canvasData,
    setCanvasData,
    orientation,
    setOrientation,
  };
  const userState = { users, selectedUsers, setSelectedUsers };

  const createCert = async () => {
    setLoading(true);

    const canvas = fabricRef.current;

    if (!canvas) {
      setLoading(false);
      return;
    }

    const objects = canvas._objects;
    const image = objects.find((object) => object instanceof Image) as Image;
    const texts = objects.filter((object) => object instanceof Text) as Text[];
    const rects = objects.filter((object) => object instanceof Rect) as Rect[];

    if (!image) {
      setLoading(false);
      return;
    }

    const content = {
      image: {
        data: image.toDataURL(),
        width: image.getScaledWidth(),
        height: image.getScaledHeight(),
        left: image.left,
        top: image.top,
      },
      texts: texts.map((text) => {
        return {
          data: text.text,
          scale: text.scaleX,
          left: text.left,
          top: text.top,
          width: text.getScaledWidth(),
          height: text.getScaledHeight(),
        };
      }),
      rects: rects.map((rect) => {
        return {
          width: rect.getScaledWidth(),
          height: rect.getScaledHeight(),
          left: rect.left,
          top: rect.top,
        };
      }),
      orientation,
    };

    const result = await fetch("/api/certs", {
      method: "POST",
      body: JSON.stringify({
        content,
        name,
        description,
        issuedAt: issueDate,
        users: selectedUsers.map((user) => user.id),
      }),
      credentials: "include",
    });

    setLoading(false);

    if (!result.ok) {
      const { error } = await result.json().catch(() => ({ error: null }));
      alert(error?.message ?? "증명서 등록에 실패했습니다.");
      return;
    }

    window.location.href = "/admin/certs";
  };

  return (
    <div className="w-full">
      <FileForm file={file} setFile={setFile} />
      <CanvasForm file={file} fabricRef={fabricRef} {...canvasState} />
      <UserForm file={file} {...userState} />
      <div className={`${file ? "block" : "hidden"} mt-3`}>
        <p className="text-xl">
          <span className="font-semibold">4.</span> 증명서 정보를 입력해 주세요
        </p>
        <div className="mt-3">
          <p className="font-semibold text-gray-600">
            증명서 이름<span className="text-red-500">*</span>
          </p>
          <input
            type="text"
            className="w-full rounded-md p-2 border border-gray-300 focus:outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="증명서 이름"
          />
        </div>
        <div className="mt-3">
          <p className="font-semibold text-gray-600">
            증명서 발급일자<span className="text-red-500">*</span>
          </p>
          <input
            type="date"
            className="w-full rounded-md p-2 border border-gray-300 focus:outline-none"
            value={issueDate}
            onChange={(e) => setIssueDate(e.target.value)}
            placeholder="증명서 발급일자"
          />
        </div>
        <div className="mt-3">
          <p className="font-semibold text-gray-600">
            증명서 설명
          </p>
          <textarea
            className="w-full rounded-md p-2 border border-gray-300 focus:outline-none"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="증명서 설명"
          />
        </div>
      </div>
      <hr className="my-6" />
      <div className={`${file ? "flex" : "hidden"} justify-end`}>
        <button
          type="button"
          onClick={createCert}
          disabled={
            loading || !selectedUsers.length || !name.trim() || !issueDate
          }
          className="mt-6 py-2 px-4 bg-blue-500 focus:bg-blue-600 text-white rounded-md disabled:opacity-50"
        >
          증명서 등록하기
        </button>
      </div>
    </div>
  );
}
