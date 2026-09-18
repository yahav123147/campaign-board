"use client";

import { useContext } from "react";
import { BoardNameContext } from "@/components/BoardNameProvider";

/**
 * The installation's name for the board, for the three places that show it.
 *
 * The value comes from the root layout, which resolves it from the client
 * profile on the server. A hook rather than a prop: the header sits in
 * ProgressBar under a client run page, and the strategy document sits three
 * levels below it under Canvas, which already carries eleven props. Threading
 * a fourteenth through both, for a value that never changes during a session,
 * buys nothing.
 */
export function useBoardName(): string {
  return useContext(BoardNameContext);
}
