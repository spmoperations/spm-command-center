"use client";

// Pictures added to a Slack reply: pasted, dropped or picked. Each is kept on the server as soon
// as it is added (see addPicture), shown small above the buttons, and sent with the reply.

import { useEffect, useRef, useState } from "react";
import { MOST_PICTURE_BYTES, MOST_PICTURES } from "@/core/config";
import type { AddedPicture } from "@/core/types";
import { addPicture, toast } from "@/store/store";

/** The kinds of picture Slack and the dashboard both take as they are. Others are made into a JPEG first. */
const SENDABLE = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** A picture too big to send is made smaller, step by step: the longest side, then the JPEG quality. */
const SMALLER: [number, number][] = [
  [2560, 0.85],
  [1920, 0.8],
  [1280, 0.75],
];

export const NEEDS_UPLOAD =
  "Pictures cannot be sent to Slack from here yet. The Slack app needs one more permission, files:write, and then has to be installed again.";

/** One picture added to the reply. It has its key once the server has it. */
export interface ReplyPicture extends Partial<AddedPicture> {
  id: string;
  name: string;
  /** The picture itself, from this browser, until it is sent. */
  preview: string;
  adding: boolean;
}

type Ready = { blob: Blob; w?: number; h?: number } | { error: string };

/** A picture as a JPEG small enough to send, white where it was see-through. Null when even the smallest step is too big. */
async function smaller(file: Blob): Promise<Ready | null> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      for (const [longest, quality] of SMALLER) {
        const scale = Math.min(
          1,
          longest / Math.max(bitmap.width, bitmap.height),
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const paint = canvas.getContext("2d");
        if (!paint) return null;
        paint.fillStyle = "#fff";
        paint.fillRect(0, 0, canvas.width, canvas.height);
        paint.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((done) =>
          canvas.toBlob(done, "image/jpeg", quality),
        );
        if (blob && blob.size <= MOST_PICTURE_BYTES)
          return { blob, w: canvas.width, h: canvas.height };
      }
    } finally {
      bitmap.close();
    }
  } catch {
    // The browser cannot read this picture.
  }
  return null;
}

/** The picture ready to go: as it is when it can be, made smaller or into a JPEG when it has to be. */
async function prepare(file: File): Promise<Ready> {
  if (SENDABLE.includes(file.type) && file.size <= MOST_PICTURE_BYTES) {
    try {
      const bitmap = await createImageBitmap(file);
      const size = { w: bitmap.width, h: bitmap.height };
      bitmap.close();
      return { blob: file, ...size };
    } catch {
      return { blob: file };
    }
  }
  return (
    (await smaller(file)) ?? {
      error: SENDABLE.includes(file.type)
        ? `“${file.name}” is too big to send, even made smaller.`
        : `“${file.name}” cannot be sent. PNG, JPEG, GIF and WebP pictures can.`,
    }
  );
}

/** The pictures added to one reply, and what can be done with them. `allowed` is whether Slack takes pictures from this app (null: not known yet). */
export function useReplyPictures(allowed: boolean | null) {
  const [pictures, setPictures] = useState<ReplyPicture[]>([]);
  const now = useRef<ReplyPicture[]>([]);
  useEffect(() => {
    now.current = pictures;
  }, [pictures]);
  // The pictures still here when the reply box closes are let go. The server lets go of its copies after a day.
  useEffect(
    () => () => now.current.forEach((p) => URL.revokeObjectURL(p.preview)),
    [],
  );

  const drop = (id: string, preview: string, error: string) => {
    toast(error);
    URL.revokeObjectURL(preview);
    setPictures((list) => list.filter((p) => p.id !== id));
  };

  const addOne = async (file: File) => {
    const id = crypto.randomUUID();
    const name = file.name || "Picture";
    const preview = URL.createObjectURL(file);
    setPictures((list) => [...list, { id, name, preview, adding: true }]);
    const ready = await prepare(file);
    if ("error" in ready) return drop(id, preview, ready.error);
    const kept = await addPicture(ready.blob);
    if ("error" in kept) return drop(id, preview, kept.error);
    setPictures((list) =>
      list.map((p) =>
        p.id === id
          ? { ...p, key: kept.key, w: ready.w, h: ready.h, adding: false }
          : p,
      ),
    );
  };

  return {
    pictures,
    /** Adds the pictures among these files. True when there was at least one, even if it could not be added. */
    add(files: File[]): boolean {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (!images.length) return false;
      if (allowed === false) {
        toast(NEEDS_UPLOAD);
        return true;
      }
      const room = MOST_PICTURES - now.current.length;
      if (images.length > room)
        toast(`At most ${MOST_PICTURES} pictures can go with one message.`);
      for (const file of images.slice(0, Math.max(0, room))) void addOne(file);
      return true;
    },
    remove(id: string) {
      const gone = pictures.find((p) => p.id === id);
      if (gone) URL.revokeObjectURL(gone.preview);
      setPictures((list) => list.filter((p) => p.id !== id));
    },
    /** What goes with the reply, or null while one is still being added. */
    ready(): AddedPicture[] | null {
      if (pictures.some((p) => p.adding || !p.key)) return null;
      return pictures.map((p) => ({
        key: p.key!,
        name: p.name,
        w: p.w,
        h: p.h,
      }));
    },
    /** Takes them all out of the box, for the reply; `putBack` returns them if it could not be sent. */
    take(): ReplyPicture[] {
      setPictures([]);
      return pictures;
    },
    putBack(taken: ReplyPicture[]) {
      setPictures((list) => [...taken, ...list]);
    },
    letGo(taken: ReplyPicture[]) {
      taken.forEach((p) => URL.revokeObjectURL(p.preview));
    },
  };
}

/** The pictures added so far, each with a way to take it out again. */
export function ReplyPictureList({
  pictures,
  onRemove,
}: {
  pictures: ReplyPicture[];
  onRemove(id: string): void;
}) {
  if (!pictures.length) return null;
  return (
    <div className="addpics">
      {pictures.map((p) => (
        <figure className={`addpic ${p.adding ? "adding" : ""}`} key={p.id}>
          {/* The picture from this browser itself: nothing to resize or cache. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.preview} alt={p.name} />
          {p.adding && <span className="addpic-busy">Adding…</span>}
          <button
            type="button"
            className="addpic-x"
            aria-label={`Take out ${p.name}`}
            title="Take out"
            onClick={() => onRemove(p.id)}
          >
            ✕
          </button>
        </figure>
      ))}
    </div>
  );
}
