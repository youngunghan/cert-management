"use client";

import { useState } from "react";

type Props = {
  certId: string;
};

export default function IssueButton({ certId }: Props) {
  const [loading, setLoading] = useState(false);

  const issueCert = async () => {
    setLoading(true);

    const response = await fetch(`/api/certs/${certId}/issue`, {
      method: "POST",
      credentials: "include",
    });

    if (!response.ok) {
      alert("발급에 실패했습니다.");
      setLoading(false);
      return;
    }

    const { data } = await response.json();

    const a = document.createElement("a");
    a.href = data.url;
    a.click();

    setLoading(false);
  };

  return (
    <button
      type="button"
      onClick={issueCert}
      disabled={loading}
      className="px-4 py-2 rounded-md bg-gray-200 focus:bg-gray-300 disabled:opacity-50"
    >
      {loading ? "발급중" : "발급하기"}
    </button>
  );
}
