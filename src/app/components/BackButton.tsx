import { useApp } from "../context";
import { Icon } from "./Icon";

// Round, translucent chevron. It returns to whatever page opened this one.
export function BackButton() {
  const { nav } = useApp();
  return (
    <button className="back-round" aria-label="Back" onClick={nav.goBack}>
      <Icon name="back" size={22} />
    </button>
  );
}
