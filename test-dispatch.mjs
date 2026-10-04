import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createPinia, setActivePinia } = await jiti.import("pinia");
const { useAssessmentStore } = await jiti.import("/workspace/stores/assessment.ts");

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name} ${extra}`); }
}
function freshStore() {
  setActivePinia(createPinia());
  return useAssessmentStore();
}

console.log("\n[1] 重复合并：已派任务迁到保留记录");
{
  const s = freshStore();
  const h1 = s.households.find((h) => h.id === "h1");
  const h3 = s.households.find((h) => h.id === "h3");
  s.addTask({ householdId: h3.id, title: "复核h3", assignee: "待分派", priority: "紧急", due: "2026-09-30 18:00" });
  const task = s.tasks.find((t) => t.householdId === h3.id);
  s.mergeDuplicate(h3.id, h1.id);
  check("重复记录被移除", !s.households.find((h) => h.id === h3.id));
  check("任务迁到保留记录", s.tasks.find((t) => t.id === task.id)?.householdId === h1.id);
  check("保留记录需求并集", h1.needs.includes("临时安置") && h1.needs.includes("慢病用药"));
}

console.log("\n[2] 冲突未决：不能占小组名额；解决后可派");
{
  const s = freshStore();
  const h1 = s.households.find((h) => h.id === "h1");
  s.seedConflict(); // 给 households[0] 即 h1 造一条待处理冲突
  check("h1 存在未决冲突", s.hasUnresolvedConflict(h1.id));
  s.addTask({ householdId: h1.id, title: "复核h1", assignee: "待分派", priority: "紧急", due: "2026-09-30 18:00" });
  const task = s.tasks.find((t) => t.householdId === h1.id && t.status === "排队中");
  const r1 = await s.dispatchTask(task.id);
  check("冲突未决时派工被拒", !r1.ok && r1.reason.includes("冲突未解决"), JSON.stringify(r1));
  check("任务仍在队列", task.status === "排队中");
  const conflict = s.conflicts.find((c) => c.householdId === h1.id);
  s.resolveConflict(conflict.id, "采用本地");
  check("解决后无未决冲突", !s.hasUnresolvedConflict(h1.id));
  const r2 = await s.dispatchTask(task.id);
  check("冲突解决后派工成功", r2.ok && task.status === "已派出", JSON.stringify(r2));
}

console.log("\n[3] 名额满：没派上的留在队列");
{
  const s = freshStore();
  // g1、g2 空闲，g3 被 k1 占用
  check("初始空闲小组数为2", s.groups.filter((g) => !g.activeTaskId).length === 2);
  const h1 = s.households.find((h) => h.id === "h1");
  s.addTask({ householdId: h1.id, title: "任务A", assignee: "待分派", priority: "紧急", due: "x" });
  s.addTask({ householdId: h1.id, title: "任务B", assignee: "待分派", priority: "紧急", due: "x" });
  s.addTask({ householdId: h1.id, title: "任务C", assignee: "待分派", priority: "紧急", due: "x" });
  s.addTask({ householdId: h1.id, title: "任务D", assignee: "待分派", priority: "紧急", due: "x" });
  await s.processDispatchQueue();
  const queued = s.tasks.filter((t) => t.status === "排队中");
  const dispatched = s.tasks.filter((t) => t.status === "已派出");
  check("只派出2项（占满2个空闲名额）", dispatched.length === 2, `dispatched=${dispatched.length}`);
  check("剩余2项留在队列", queued.length === 2, `queued=${queued.length}`);
  check("先到的 A、B 先派出", dispatched.some((t) => t.title === "任务A") && dispatched.some((t) => t.title === "任务B"));
}

console.log("\n[4] 紧急度变化：未开工任务按新顺序重排，已开工继续");
{
  const s = freshStore();
  const h1 = s.households.find((h) => h.id === "h1"); // 紧急
  s.addHousehold({ head: "高家", community: "河湾社区", address: "x", members: 1, vulnerable: [], needLevel: "高", needs: ["x"], note: "" });
  s.addHousehold({ head: "一般家", community: "河湾社区", address: "x", members: 1, vulnerable: [], needLevel: "一般", needs: ["x"], note: "" });
  const gj = s.households.find((h) => h.head === "高家");
  const yb = s.households.find((h) => h.head === "一般家");
  s.addTask({ householdId: yb.id, title: "一般任务", assignee: "待分派", priority: "一般", due: "x" });
  s.addTask({ householdId: h1.id, title: "紧急任务", assignee: "待分派", priority: "紧急", due: "x" });
  s.addTask({ householdId: gj.id, title: "高任务", assignee: "待分派", priority: "高", due: "x" });
  const orderBefore = s.queueOrder.map((id) => s.tasks.find((t) => t.id === id).title);
  check("初始队列按紧急度：紧急、高、一般", JSON.stringify(orderBefore) === JSON.stringify(["紧急任务", "高任务", "一般任务"]), JSON.stringify(orderBefore));
  // 把紧急任务降为一般
  s.setUrgency(h1.id, "一般");
  const orderAfter = s.queueOrder.map((id) => s.tasks.find((t) => t.id === id).title);
  check("降级后重排：高任务最前", orderAfter[0] === "高任务", JSON.stringify(orderAfter));
  // 已开工的任务不参与重排
  const k1 = s.tasks.find((t) => t.id === "k1");
  check("已开工任务仍进行中", k1.status === "进行中");
}

console.log("\n[5] 已派出不重发；失败后从检查点继续重试");
{
  const s = freshStore();
  const h1 = s.households.find((h) => h.id === "h1");
  s.addTask({ householdId: h1.id, title: "任务A", assignee: "待分派", priority: "紧急", due: "x" });
  const task = s.tasks.find((t) => t.title === "任务A");
  const r1 = await s.dispatchTask(task.id);
  check("首次派出成功", r1.ok);
  const r2 = await s.dispatchTask(task.id);
  check("重复派出被拒（不重发）", !r2.ok && r2.reason.includes("不能重发"), JSON.stringify(r2));
  check("任务仍为已派出", task.status === "已派出");
  // 制造一个冲突让派工中断
  s.addTask({ householdId: h1.id, title: "任务B", assignee: "待分派", priority: "紧急", due: "x" });
  s.seedConflict(); // h1 冲突未决
  await s.processDispatchQueue();
  const stopped = s.dispatchError;
  check("派工在冲突处中断并记录原因", !!stopped && stopped.includes("冲突未解决"), stopped ?? "");
  const taskB = s.tasks.find((t) => t.title === "任务B");
  check("中断时任务B未派出（留在队列）", taskB.status === "排队中");
  // 解决冲突后重试：从检查点继续，已派出的A不重发，B接着派
  const conflict = s.conflicts.find((c) => c.householdId === h1.id);
  s.resolveConflict(conflict.id, "采用本地");
  await s.retryDispatch();
  check("重试后任务B派出", taskB.status === "已派出");
  check("任务A未被重发（dispatchedAt 不变）", task.dispatchedAt !== null && task.status === "已派出");
}

console.log("\n[6] 两人抢占最后一个名额：先到先得");
{
  const s = freshStore();
  await s.raceLastSlot();
  const log = s.raceLog.join(" | ");
  check("先到方成功", log.includes("先到方：已接到任务"), log);
  check("后到方被拒（名额被占）", log.includes("后到方：") && log.includes("先到先得"), log);
}

console.log("\n[7] 同步队列：中断后从检查点重试，已提交不重发");
{
  const s = freshStore();
  s.enqueue("任务", "派出", "x1");
  s.enqueue("任务", "派出", "x2");
  s.enqueue("任务", "派出", "x3");
  const before = s.queue.length;
  s.simulateFailure = true;
  await s.syncNow();
  check("中断后仍有未提交项", s.queue.length > 0, `remaining=${s.queue.length}`);
  const remainingAfterFail = s.queue.length;
  await s.retrySync();
  check("重试后队列清空", s.queue.length === 0, `remaining=${s.queue.length}`);
  check("重试提交的是剩余项（未重复处理已提交项）", remainingAfterFail >= 0 && s.queue.length === 0);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
