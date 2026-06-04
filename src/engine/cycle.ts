import type { MenuModel } from "./menu.ts";

export interface PollOutcome {
  menu: MenuModel;
  behind: number;
}

const PLACEHOLDER_MENU: MenuModel = {
  rows: [
    { kind: "header", label: "skill-drift — no data yet" },
    { kind: "separator" },
    { kind: "quit", label: "Quit skill-drift" },
  ],
};

export async function runPollCycle(): Promise<PollOutcome> {
  return { menu: PLACEHOLDER_MENU, behind: 0 };
}
