import { DashboardFrame } from "../ui/dashboard-frame";

export function DreamsView() {
  return (
    <div className="flex flex-col h-full w-full">
      <DashboardFrame path="/dreams" title="Dream Engine Dashboard" />
    </div>
  );
}
