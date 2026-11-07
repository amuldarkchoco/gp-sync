import { esc } from "./dom";

/** A backup-queue setting, not an action to add files from the current device. */
export function backupPriorityControl(path: string, position: number, hasWaiting: boolean): string {
  const active = position >= 0;
  const status = active ? `Priority #${position + 1}` : "Normal order";
  const description = hasWaiting
    ? "Move this folder's waiting files up in the backup queue."
    : "No files are waiting. Priority applies to future backups.";
  return `<div class="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2 text-sm font-medium">Backup priority <span class="text-xs font-normal text-ink-3">${status}</span></div>
      <p class="mt-1 text-xs text-ink-3">${description} This doesn't add files. A scan may start; pause and upload hours still apply.</p>
    </div>
    <button type="button" class="switch" role="switch" data-prio-toggle="${esc(path)}" aria-checked="${active}" aria-label="Prioritize backup for ${esc(path)}"></button>
  </div>`;
}
