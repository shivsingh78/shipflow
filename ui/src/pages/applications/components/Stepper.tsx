import { Check } from "lucide-react";
import { STEPS } from "../lib/configForm";
import type { StepNumber } from "../lib/configForm";

/** Step indicator that doubles as navigation: you can go back, and forward to steps you have already reached. */
export function Stepper({ current, reached, onGo, locked = false }: { current: StepNumber; reached: StepNumber; onGo: (step: StepNumber) => void; locked?: boolean }) {
  return (
    <nav aria-label="Create application steps">
      <ol className="stepper">
        {STEPS.map((label, index) => {
          const step = (index + 1) as StepNumber;
          const done = step < current;
          const reachable = !locked && step <= reached;

          return (
            <li key={label} className="stepper__item" data-done={done}>
              <button type="button" aria-current={step === current ? "step" : undefined} disabled={!reachable && step !== current} onClick={() => onGo(step)}>
                <span className="stepper__num">{done ? <Check size={12} aria-hidden /> : step}</span>
                <span className="stepper__label">{label}</span>
                {done ? <span className="sr-only"> (completed)</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
