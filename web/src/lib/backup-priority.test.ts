import { describe, expect, it } from "vite-plus/test";
import { backupPriorityControl } from "./backup-priority";

describe("backup priority control", () => {
  it("explains the normal queue and exposes an unchecked switch", () => {
    const markup = backupPriorityControl("Photos/Phone", -1, true);
    expect(markup).toContain("Normal order");
    expect(markup).toContain("Move this folder's waiting files up in the backup queue");
    expect(markup).toContain("doesn't add files");
    expect(markup).toContain("A scan may start");
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain('data-prio-toggle="Photos/Phone"');
  });

  it("keeps an existing priority removable when no files are waiting", () => {
    const markup = backupPriorityControl('Photos/<"Phone">', 1, false);
    expect(markup).toContain("Priority #2");
    expect(markup).toContain("Priority applies to future backups");
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('data-prio-toggle="Photos/&lt;&quot;Phone&quot;&gt;"');
  });
});
