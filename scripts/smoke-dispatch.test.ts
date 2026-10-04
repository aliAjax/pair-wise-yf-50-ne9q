import assert from "node:assert";
import {
  activeCount,
  claimReview,
  completeReview,
  contendSlot,
  createInitialDispatchState,
  enqueueReview,
  ingestBatch,
  mergeInto,
  queuedReviews,
  runDispatch,
  setNeedLevel,
  startReview,
  type DispatchHousehold,
  type DispatchState
} from "../utils/dispatch.ts";

let pass = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, name);
  console.log(`✓ ${name}`);
  pass++;
}

function seedHouseholds(): DispatchHousehold[] {
  return [
    { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["用药"], status: "待复核", version: 1, deviceUpdatedAt: "" },
    { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "待复核", version: 1, deviceUpdatedAt: "" },
    { id: "dup", head: "王建国", community: "河湾社区", address: "河湾路18号2幢", members: 4, vulnerable: [], needLevel: "紧急", needs: ["安置"], status: "待评估", version: 1, deviceUpdatedAt: "" }
  ];
}
function seedState(): DispatchState {
  return createInitialDispatchState([
    { id: "g1", name: "复核一组", capacity: 1 },
    { id: "g2", name: "复核二组", capacity: 2 }
  ]);
}

// 1. 重复家庭只保留一条，已派/在队任务迁到保留记录
{
  const hs = seedHouseholds();
  const st = seedState();
  enqueueReview(hs, st, { householdId: "dup", groupId: "g1" });
  const claimed = claimReview(hs, st, { groupId: "g1", householdId: "dup", actor: "t" });
  assert.ok(claimed.ok);
  enqueueReview(hs, st, { householdId: "h1", groupId: "g2" });
  mergeInto(hs, st, "dup", "h1");
  check("合并后只剩一个王建国", hs.filter((h) => h.head === "王建国").length === 1);
  check("已派任务迁到保留记录 h1", st.reviews.every((r) => r.householdId === "h1"));
  check("需求取并集", hs[0].needs.includes("用药") && hs[0].needs.includes("安置"));
  check("合并后 g1 仍占 1 个名额（迁移不丢名额）", activeCount(st, "g1") === 1);
}

// 2. 冲突未定稿的家庭不能占小组名额
{
  const hs = seedHouseholds();
  const st = seedState();
  enqueueReview(hs, st, { householdId: "h1", groupId: "g1" });
  ingestBatch(hs, st, {
    batchId: "b1",
    device: "PDA-C",
    items: [{ head: "王建国", community: "河湾社区", address: "河湾路18号2栋", members: 5, vulnerable: ["老人"], needLevel: "一般", needs: [], note: "x" }]
  });
  check("冲突家庭被冻结", Boolean(hs.find((h) => h.id === "h1")?.blocked));
  const r = claimReview(hs, st, { groupId: "g1", householdId: "h1", actor: "t" });
  check("冻结家庭抢占名额失败", !r.ok && r.reason?.includes("冻结"));
  check("冻结家庭没有占用名额", activeCount(st, "g1") === 0);
  check("没派上的任务留在队列", st.reviews.some((x) => x.householdId === "h1" && x.status === "排队"));
}

// 3. 紧急度变化：未开工重排，已开工不动
{
  const hs = seedHouseholds();
  const st = seedState();
  enqueueReview(hs, st, { householdId: "h2", groupId: "g2" }); // 一般，seq 先
  enqueueReview(hs, st, { householdId: "h1", groupId: "g2" }); // 紧急
  let order = queuedReviews(hs, st, "g2").map((r) => r.householdId);
  check("紧急排在一般前面", order[0] === "h1");
  // 把 h1 派出并开工
  const g2free = claimReview(hs, st, { groupId: "g2", householdId: "h1", actor: "t" });
  assert.ok(g2free.ok);
  startReview(hs, st, g2free.review!.id);
  setNeedLevel(hs, st, "h2", "紧急");
  const running = st.reviews.find((r) => r.householdId === "h1");
  check("已开工任务继续跑（状态不变）", running?.status === "进行中");
  // 完成后释放
  completeReview(hs, st, running!.id);
  check("完工释放名额", activeCount(st, "g2") === 0);
}

// 4. 两人同时抢占最后名额：只让先到的一方接到任务
{
  const hs = seedHouseholds();
  const st = seedState(); // g1 容量1，空
  enqueueReview(hs, st, { householdId: "h1", groupId: "g1" });
  enqueueReview(hs, st, { householdId: "h2", groupId: "g1" });
  const t0 = "2026-10-04T01:00:00.000Z";
  const results = contendSlot(hs, st, [
    { groupId: "g1", householdId: "h2", actor: "甲", arrivedAt: new Date(+new Date(t0) + 500).toISOString() }, // 后到（一般）
    { groupId: "g1", householdId: "h1", actor: "乙", arrivedAt: t0 } // 先到（紧急）
  ]);
  check("先到者成功，与紧急度无关", results[0].actor === "乙" && results[0].ok);
  check("后到者失败并报告名额已满", results[1].actor === "甲" && !results[1].ok && results[1].reason?.includes("已满"));
  check("只有一个任务占用名额", activeCount(st, "g1") === 1);
  check("失败者任务留在队列", st.reviews.find((r) => r.householdId === "h2")?.status === "排队");
}

// 5. 可恢复流水线：派工中崩溃 → 已派不重派、已送达不重发，断点继续
{
  const hs = seedHouseholds();
  const st = seedState();
  enqueueReview(hs, st, { householdId: "h1", groupId: "g2" });
  enqueueReview(hs, st, { householdId: "h2", groupId: "g2" });
  // 让派工在第一项成功后崩溃（g2 有2个名额）
  const run1 = runDispatch(hs, st, { failAt: "派工" });
  check("流水线标记失败", run1.status === "失败");
  const afterCrash = st.reviews.filter((r) => r.status === "已派出").length;
  check("崩溃前已成功派出 1 项（outbox 待同步）", afterCrash === 1 && st.outbox.filter((o) => !o.sent).length === 1);
  // 断点继续（不再注入故障）
  const run2 = runDispatch(hs, st);
  check("继续后完成全部检查点", run2.status === "完成" && run2.runId === run1.runId);
  check("恢复后共派出 2 项，没有重派第一个", st.reviews.filter((r) => r.status === "已派出").length === 2);
  check("两条送达请求都只发一次", st.outbox.every((o) => o.sent) && st.outbox.length === 2);
  // 再次调用应为空操作幂等（新run快速跳过语义不同：检查旧 run 已完成）
  check("旧 run 已终结不会再执行", st.activeRunId === undefined);
}

// 6. 送达弱网中断：未确认请求留在队列，恢复后才标记送达
{
  const hs = seedHouseholds();
  const st = seedState();
  enqueueReview(hs, st, { householdId: "h1", groupId: "g1" });
  const r1 = runDispatch(hs, st, { failAt: "同步送达" });
  check("派工检查点完成、送达失败", r1.checkpoints["派工"] && !r1.checkpoints["同步送达"]);
  check("未确认请求仍留在待同步队列", st.outbox.some((o) => !o.sent));
  runDispatch(hs, st);
  check("恢复后待同步全部送达且无重复", st.outbox.length === 1 && st.outbox[0]!.sent);
}

// 7. 批次补传幂等 + 新家庭自动入队
{
  const hs = seedHouseholds();
  const st = seedState();
  const batch = { batchId: "dup-batch", device: "PDA-X", items: [{ head: "周阿婆", community: "堤北社区", address: "堤北2排7号", members: 1, vulnerable: ["老人"], needLevel: "一般", needs: ["食品"], note: "" }] };
  ingestBatch(hs, st, batch, { defaultGroupId: "g2" });
  ingestBatch(hs, st, batch, { defaultGroupId: "g2" }); // 重放
  check("重复批次不重复入库", hs.filter((h) => h.head === "周阿婆").length === 1);
  check("新家庭补传后自动排队", st.reviews.some((r) => r.status === "排队" && r.groupId === "g2"));
}

// 8. 入队幂等 + 完成后释放名额供下一户
{
  const hs = seedHouseholds();
  const st = seedState();
  const a = enqueueReview(hs, st, { householdId: "h1", groupId: "g1" });
  const b = enqueueReview(hs, st, { householdId: "h1", groupId: "g1" });
  check("同一家庭同组未完成任务不重复入队", a?.id === b?.id && st.reviews.length === 1);
  const r = claimReview(hs, st, { groupId: "g1", householdId: "h1", actor: "t" });
  assert.ok(r.ok);
  startReview(hs, st, r.review!.id);
  completeReview(hs, st, r.review!.id);
  enqueueReview(hs, st, { householdId: "h2", groupId: "g1" });
  const r2 = claimReview(hs, st, { groupId: "g1", householdId: "h2", actor: "t" });
  check("释放名额后下一户可派", r2.ok);
  check("已派出任务不能重发（再抢同任务被拒）", !claimReview(hs, st, { groupId: "g1", householdId: "h2", actor: "t2" }).ok);
}

console.log(`\n全部通过：${pass} 项断言`);
