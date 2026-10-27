import type { SetupState, StepId } from "@/api/setup";

export type StepProps = {
  setup: SetupState;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  // Called when this step finished on screen: the wizard moves on after the check has drawn.
  onDone: () => void;
  reopen: (id: StepId) => void;
};
