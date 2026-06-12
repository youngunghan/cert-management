"use client";

import { MutableRefObject, useCallback, useEffect, useState } from "react";

import { Canvas, Object as FabricObject, Image, Rect, Text } from "fabric";

import useDebounceFabric from "lib/debounceFabric";

import IconCenter from "assets/icons/icon_align_center.svg";
import IconHorizontal from "assets/icons/icon_horizontal.svg";
import IconQrCode from "assets/icons/icon_qrcode.svg";
import IconText from "assets/icons/icon_text.svg";
import IconVertical from "assets/icons/icon_vertical.svg";

export type CanvasTextData = {
  type: "text";
  width: number;
  height: number;
  scale: number;
  text: string;
};

export type CanvasQRData = {
  type: "qr";
  width: number;
  height: number;
  scale: number;
};

export type CanvasData = CanvasTextData | CanvasQRData;

type Props = {
  file: File | null;
  fabricRef: MutableRefObject<Canvas | undefined>;
  canvasData: CanvasData[];
  setCanvasData: React.Dispatch<React.SetStateAction<CanvasData[]>>;
  orientation: "landscape" | "portrait";
  setOrientation: React.Dispatch<
    React.SetStateAction<"landscape" | "portrait">
  >;
};

export default function CanvasForm({
  file,
  fabricRef,
  orientation,
  setOrientation,
}: Props) {
  const [top, setTop] = useState(0);
  const [left, setLeft] = useState(0);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [value, setValue] = useState("");

  useDebounceFabric(fabricRef, "top", top, setTop);
  useDebounceFabric(fabricRef, "left", left, setLeft);
  useDebounceFabric(fabricRef, "width", width, setWidth);
  useDebounceFabric(fabricRef, "height", height, setHeight);
  useDebounceFabric(fabricRef, "text", value, setValue);

  const [selectedInfo, setSelectedInfo] = useState("선택된 요소가 없습니다.");

  const canvasWidth = orientation === "landscape" ? 1024 : 720;
  const canvasHeight = orientation === "landscape" ? 720 : 1024;

  useEffect(() => {
    const canvas = new Canvas("canvas-main", {
      width: canvasWidth,
      height: canvasHeight,
    });
    fabricRef.current = canvas;

    if (file) {
      (async () => {
        const image = await Image.fromURL(URL.createObjectURL(file));
        image.lockMovementX = true;
        image.lockMovementY = true;
        image.lockScalingX = true;
        image.lockScalingY = true;
        image.lockRotation = true;
        image.selectable = false;
        image.hasControls = false;

        if (image.width > image.height) {
          // Center and adjust width and height to fit in the canvas
          // image.left is calulated by the center of the image
          image.scaleToWidth(canvas.width);
        } else {
          // Center and adjust width and height to fit in the canvas
          image.scaleToHeight(canvas.height);
        }

        canvas.add(image);
        canvas.centerObject(image);
      })();
    }

    const setValues = (selected: FabricObject) => {
      setSelectedInfo(selected instanceof Text ? "텍스트" : "QR 코드");
      setTop(selected.top);
      setLeft(selected.left);
      setWidth(selected.width);
      setHeight(selected.height);

      if (selected instanceof Text) {
        setValue(selected.text);
      }
    };

    canvas.on("selection:created", (e) => {
      if (e.selected.length > 1) {
        setSelectedInfo("여러 요소가 선택되었습니다.");
      }
      const selected = e.selected[0];
      setValues(selected);
    });

    canvas.on("selection:updated", (e) => {
      if (e.selected.length > 1) {
        setSelectedInfo("여러 요소가 선택되었습니다.");
      }
      const selected = e.selected[0];
      setValues(selected);
    });

    canvas.on("selection:cleared", () => {
      setSelectedInfo("선택된 요소가 없습니다.");
    });

    canvas.on("object:moving", (e) => {
      const selected = e.target;
      setValues(selected);
    });

    canvas.on("object:scaling", (e) => {
      const selected = e.target;
      setValues(selected);
    });

    return () => {
      canvas.dispose();
    };
  }, [orientation, file]);

  const addText = useCallback(() => {
    const text = new Text("여기에 텍스트 입력", {
      fontFamily: "ChosunGs",
      textAlign: "center",
    });

    text.lockScalingFlip = true;
    text.lockRotation = true;
    text.lockScalingX = true;
    text.lockScalingY = true;

    fabricRef.current?.add(text);
    fabricRef.current?.bringObjectToFront(text);
  }, [fabricRef.current]);

  const addQrCode = useCallback(() => {
    const rect = new Rect({
      width: 100,
      height: 100,
      fill: "red",
    });

    rect.lockScalingFlip = true;
    rect.lockRotation = true;

    fabricRef.current?.add(rect);
    fabricRef.current?.bringObjectToFront(rect);
  }, [fabricRef.current]);

  return (
    <div className={`mt-3 ${file ? "block" : "hidden"}`}>
      <p className="text-xl">
        <span className="font-semibold">2.</span> 증명서 내용을 입력해 주세요
      </p>
      <div className="flex items-center">
        <p>
          &#123;&#123;Name&#125;&#125;, &#123;&#123;IssueDate&#125;&#125;,
          &#123;&#123;PrintDate&#125;&#125; 등으로 날짜와 이름를 입력할 수
          있습니다.
        </p>
        <div className="flex-1" />
        <button
          type="button"
          className={`rounded-l-md ${
            orientation === "portrait"
              ? "bg-gray-200 hover:bg-gray-300"
              : "bg-gray-400 hover:bg-gray-500"
          }  p-2`}
          onClick={() => setOrientation("landscape")}
        >
          <IconHorizontal className="w-5 h-5" />
        </button>
        <button
          type="button"
          className={`rounded-r-md ${
            orientation === "landscape"
              ? "bg-gray-200 hover:bg-gray-300"
              : "bg-gray-400 hover:bg-gray-500"
          } p-2`}
          onClick={() => setOrientation("portrait")}
        >
          <IconVertical className="w-5 h-5" />
        </button>
        <div className="w-3" />
        <button
          type="button"
          className="rounded-md bg-gray-200 hover:bg-gray-300 p-2"
          onClick={addText}
        >
          <IconText className="w-5 h-5" />
        </button>
        <div className="w-3" />
        <button
          type="button"
          className="rounded-md bg-gray-200 hover:bg-gray-300 p-2"
          onClick={addQrCode}
        >
          <IconQrCode className="w-5 h-5" />
        </button>
      </div>
      <div className="w-full mt-6 flex flex-col xl:flex-row  justify-start items-center xl:justify-center xl:items-start">
        <canvas
          id="canvas-main"
          className="border border-gray-300"
          width={orientation === "landscape" ? 1024 : 720}
          height={orientation === "landscape" ? 720 : 1024}
        />
        <div className="w-6 h-6" />
        <div className="w-full xl:w-[320px] shrink-0 grow-0 overflow-hidden">
          <p className="text-xl font-semibold">{selectedInfo}</p>
          {["텍스트", "QR 코드"].includes(selectedInfo) && (
            <>
              <div className="mt-3">
                <div className="flex justify-between items-center">
                  <p className="font-semibold">좌표</p>
                  <button
                    type="button"
                    className="rounded-l-md bg-gray-200 hover:bg-gray-300 p-2"
                    onClick={() => setLeft(canvasWidth / 2 - width / 2)}
                  >
                    <IconCenter className="w-5 h-5" />
                  </button>
                </div>
                <div className="mt-3 flex w-full items-center">
                  <p className="mx-3 w-6">X :</p>
                  <input
                    className="border border-gray-300 rounded-md p-1 flex-1"
                    type="number"
                    value={left}
                    onChange={(e) => setLeft(Number(e.currentTarget.value))}
                  />
                </div>
                <div className="flex w-full items-center">
                  <p className="mx-3 w-6">Y :</p>
                  <input
                    className="border border-gray-300 rounded-md p-1 flex-1"
                    type="number"
                    value={top}
                    onChange={(e) => setTop(Number(e.currentTarget.value))}
                  />
                </div>
              </div>
              <div className="mt-3">
                <p className="font-semibold">크기</p>
                <div className="flex w-full items-center">
                  <p className="mx-3 w-6">W :</p>
                  <input
                    className="border border-gray-300 rounded-md p-1 flex-1"
                    type="number"
                    value={width}
                    onChange={(e) => setWidth(Number(e.currentTarget.value))}
                  />
                </div>
                <div className="flex w-full items-center">
                  <p className="mx-3 w-6">H :</p>
                  <input
                    className="border border-gray-300 rounded-md p-1 flex-1"
                    type="number"
                    value={height}
                    onChange={(e) => setHeight(Number(e.currentTarget.value))}
                  />
                </div>
              </div>
              {selectedInfo === "텍스트" && (
                <div className="mt-3">
                  <p className="font-semibold">텍스트</p>
                  <input
                    className="border border-gray-300 rounded-md p-1 w-full"
                    type="text"
                    value={value}
                    onChange={(e) => setValue(e.currentTarget.value)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
