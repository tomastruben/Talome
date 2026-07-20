"use client";

import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  audioPlayerBookAtom,
  audioPlayerCommandAtom,
  audioPlayerErrorAtom,
  audioPlayerStateAtom,
  INITIAL_AUDIO_PLAYER_STATE,
} from "@/atoms/audio-player";
import { parseDesktopAudiobookCommandMessage } from "@/atoms/desktop-audiobook-player";

export function DesktopAudiobookPlayerBridge() {
  const book = useAtomValue(audioPlayerBookAtom);
  const state = useAtomValue(audioPlayerStateAtom);
  const error = useAtomValue(audioPlayerErrorAtom);
  const setCommand = useSetAtom(audioPlayerCommandAtom);

  useEffect(() => {
    window.parent.postMessage(
      { type: "talome:desktop-audiobook-state", book, state, error },
      window.location.origin,
    );
  }, [book, error, state]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) {
        return;
      }
      const command = parseDesktopAudiobookCommandMessage(event.data);
      if (command) setCommand(command);
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      window.parent.postMessage(
        {
          type: "talome:desktop-audiobook-state",
          book: null,
          state: INITIAL_AUDIO_PLAYER_STATE,
          error: null,
        },
        window.location.origin,
      );
    };
  }, [setCommand]);

  return null;
}
