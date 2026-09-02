"use client";

import { useCallback } from "react";
import { useMutation } from "convex/react";
import type { FunctionArgs, FunctionReference } from "convex/server";
import { record } from "@/components/undoHistory";

/**
 * A Convex mutation that Cmd+Z can take back.
 *
 * Same shape as `useMutation`, but the call takes the arguments that
 * PUT THINGS BACK alongside the ones that make the change, and a label
 * for the toast. Nearly every field mutation here is "this id, these
 * fields", so the inverse is the same mutation with the old value —
 * the caller builds it from the record it is already holding, the
 * same way it built the change, so an empty string clears in both
 * directions or in neither.
 *
 *   await save({ npcId, middle: next }, { npcId, middle: prev }, "Middle name");
 *
 * The entry is registered only once the server has accepted the change.
 * A refused save never happened, so there is nothing to undo, and a
 * stack entry for it would put the field's OLD value back over a value
 * that had not changed.
 */
export function useUndoableMutation<M extends FunctionReference<"mutation">>(
  ref: M
) {
  const mutate = useMutation(ref);
  return useCallback(
    async (args: FunctionArgs<M>, prev: FunctionArgs<M>, label: string) => {
      const result = await mutate(args);
      record({
        label,
        undo: () => mutate(prev),
        redo: () => mutate(args),
      });
      return result;
    },
    [mutate]
  );
}
