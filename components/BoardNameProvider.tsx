"use client";

import { createContext } from "react";
import { DEFAULT_BOARD_NAME } from "@/lib/boardName";

/**
 * The installation's name for the board, resolved once on the server.
 *
 * The root layout already reads the client profile to title the browser tab,
 * so it hands the same resolved name down here. Having the header fetch it
 * instead made every page paint the neutral default first and swap to the real
 * name a moment later, which is a visible flash on every load.
 *
 * The default is what a tree with no provider sees, which keeps the components
 * renderable in isolation and in tests.
 */
export const BoardNameContext = createContext<string>(DEFAULT_BOARD_NAME);

export function BoardNameProvider({ value, children }: { value: string; children: React.ReactNode }) {
  return <BoardNameContext.Provider value={value}>{children}</BoardNameContext.Provider>;
}
