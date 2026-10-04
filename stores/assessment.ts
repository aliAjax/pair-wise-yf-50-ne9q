import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
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
  reorderQueued,
  resolveConflict as resolveEngineConflict,
  runDispatch,
  setNeedLevel,
  startReview,
  uid,
  type ArrivalRequest,
  type ClaimResult,
  type DispatchHousehold,
  type DispatchRun,
  type DispatchState,
  type IncomingBatch,
  type NeedLevel,
  type ReviewTask
} from "~/utils/dispatch";

export type { NeedLevel } from "~/utils/dispatch";
export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type TaskStatus = "待接收" | "进行中" | "已完成";

export interface Household extends DispatchHousehold {}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
}

export interface PendingChange {
  id: string;
  entity: string;
  action: string;
  detail: string;
  time: string;
}

export type { CrewGroup, FieldConflict, ReviewStatus } from "~/utils/dispatch";

const KEY = "pair-wise-yf-50/assessment/v2";

const nowIso = () => new Date().toISOString();

const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: nowIso(), note: "疑似重复登记" },
  { id: "h4", head: "李秀兰", community: "河湾社区", address: "河湾路42号1单元", members: 3, vulnerable: ["孕妇"], needLevel: "高", needs: ["医疗转运"], status: "待复核", version: 1, deviceUpdatedAt: new Date(Date.now() - 8 * 60000).toISOString(), note: "孕晚期，需尽快转运" },
  { id: "h5", head: "陈守义", community: "河湾社区", address: "河湾路7号平房", members: 1, vulnerable: ["残障"], needLevel: "一般", needs: ["应急食品"], status: "待复核", version: 1, deviceUpdatedAt: new Date(Date.now() - 20 * 60000).toISOString(), note: "行动不便" }
];

const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-10-05 16:00" }
];

const seedGroups = [
  { id: "g1", name: "复核一组", capacity: 1 },
  { id: "g2", name: "复核二组", capacity: 2 }
];

function buildSeedDispatch(households: Household[]): DispatchState {
  const state = createInitialDispatchState(seedGroups);
  // 复核一组容量1且已有1项在跑 → 只剩0个名额，用于演示抢占最后名额
  const running: ReviewTask = {
    id: "r-seed-run",
    householdId: "h2",
    groupId: "g1",
    title: "现场复核",
    priority: "一般",
    status: "进行中",
    seq: 1,
    enqueuedAt: new Date(Date.now() - 40 * 60000).toISOString(),
    assignedAt: new Date(Date.now() - 35 * 60000).toISOString(),
    startedAt: new Date(Date.now() - 30 * 60000).toISOString()
  };
  const queuedH1: ReviewTask = {
    id: "r-seed-h1",
    householdId: "h1",
    groupId: "g1",
    title: "现场复核",
    priority: "紧急",
    status: "排队",
    seq: 2,
    enqueuedAt: new Date(Date.now() - 10 * 60000).toISOString(),
    lastReason: "等待复核一组名额"
  };
  const queuedH5: ReviewTask = {
    id: "r-seed-h5",
    householdId: "h5",
    groupId: "g1",
    title: "现场复核",
    priority: "一般",
    status: "排队",
    seq: 3,
    enqueuedAt: new Date(Date.now() - 6 * 60000).toISOString()
  };
  const queuedH4: ReviewTask = {
    id: "r-seed-h4",
    householdId: "h4",
    groupId: "g2",
    title: "现场复核",
    priority: "高",
    status: "排队",
    seq: 4,
    enqueuedAt: new Date(Date.now() - 4 * 60000).toISOString()
  };
  state.reviews = [running, queuedH1, queuedH5, queuedH4];
  state.seq = 5;
  state.outbox = [
    {
      id: "o-seed",
      requestId: "req-seed-sent",
      reviewId: running.id,
      groupId: "g1",
      action: "派出现场复核",
      detail: "复核一组 ← 赵敏 / 现场复核",
      time: running.assignedAt!,
      sent: true,
      sentAt: running.assignedAt
    }
  ];
  state.log.unshift({ id: uid("log"), time: nowIso(), kind: "派工", message: "现场恢复：复核一组 1 项进行中，h1/h5 排队；复核二组有空位" });
  reorderQueued(households, state);
  return state;
}

export const useAssessmentStore = defineStore("assessment", () => {
  const persisted = typeof window !== "undefined" ? localStorage.getItem(KEY) : null;
  const initial = persisted ? JSON.parse(persisted) : null;

  const households = ref<Household[]>(initial?.households ?? seedHouseholds);
  const tasks = ref<FieldTask[]>(initial?.tasks ?? seedTasks);
  const queue = ref<PendingChange[]>(initial?.queue ?? []);
  const online = ref(true);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? nowIso());
  const syncing = ref(false);

  // 恢复分组派工状态（小组容量、复核任务、字段冲突、待同步发件箱、补传收件箱、检查点日志）
  // 首次使用时用当前 households 构建种子，保证任务与家庭引用一致
  const dispatch = ref<DispatchState>(
    initial?.dispatch ?? buildSeedDispatch((initial?.households ?? seedHouseholds).map((item) => ({ ...item })))
  );

  const conflicts = computed(() => dispatch.value.conflicts);

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: queue.value.length,
    queuedReviews: dispatch.value.reviews.filter((item) => item.status === "排队").length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  const activeRun = computed<DispatchRun | undefined>(() =>
    dispatch.value.journals.find((run) => run.runId === dispatch.value.activeRunId && run.status !== "完成")
  );

  function enqueue(entity: string, action: string, detail: string) {
    queue.value.unshift({ id: uid("q"), entity, action, detail, time: nowIso() });
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt" | "blocked" | "mergedFrom">) {
    households.value.unshift({ ...input, id: uid("h"), status: "待评估", version: 1, deviceUpdatedAt: nowIso() });
    enqueue("家庭需求记录", "新增", input.head);
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: nowIso() });
    if (patch.needLevel) reorderQueued(households.value, dispatch.value);
    enqueue("家庭需求记录", "修改", `${household.head}：${Object.keys(patch).join("、")}`);
  }

  // 手动合并重复记录：保留一条，已派/在队任务与未决冲突迁到保留记录
  function mergeDuplicate(sourceId: string, targetId: string) {
    const source = households.value.find((item) => item.id === sourceId);
    if (!source) return;
    const detail = `${source.head} → ${targetId}`;
    mergeInto(households.value, dispatch.value, sourceId, targetId);
    enqueue("重复记录", "合并", detail);
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    tasks.value.unshift({ ...input, id: uid("k"), status: "待接收" });
    const household = households.value.find((item) => item.id === input.householdId);
    if (household && household.status !== "已完成") household.status = "已分派";
    enqueue("任务", "分派", `${input.title} / ${input.assignee}`);
  }

  function advanceTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return;
    task.status = task.status === "待接收" ? "进行中" : "已完成";
    if (task.status === "已完成") {
      const open = tasks.value.some((item) => item.householdId === task.householdId && item.status !== "已完成");
      const household = households.value.find((item) => item.id === task.householdId);
      if (household && !open) household.status = "已完成";
    }
    enqueue("任务", "状态流转", `${task.title} → ${task.status}`);
  }

  // ---- 恢复分组派工动作 ----

  function enqueueReviewTask(householdId: string, groupId: string) {
    return enqueueReview(households.value, dispatch.value, { householdId, groupId });
  }

  function claim(groupId: string, householdId: string, actor: string): ClaimResult {
    const result = claimReview(households.value, dispatch.value, { groupId, householdId, actor });
    if (result.ok) enqueue("现场复核", "派工", `${actor} 接到 ${householdId}`);
    return result;
  }

  /** 两人同时抢占最后一个名额，按到达时间决出唯一成功者 */
  function contendLastSlot(requests: Array<ArrivalRequest>) {
    return contendSlot(households.value, dispatch.value, requests);
  }

  function startReviewTask(reviewId: string) {
    startReview(households.value, dispatch.value, reviewId);
  }

  function completeReviewTask(reviewId: string) {
    completeReview(households.value, dispatch.value, reviewId);
    enqueue("现场复核", "完工", reviewId);
  }

  function changeNeedLevel(householdId: string, level: NeedLevel) {
    setNeedLevel(households.value, dispatch.value, householdId, level);
    enqueue("家庭需求记录", "紧急度调整", `${householdId} → ${level}`);
  }

  function receiveBatch(batch: IncomingBatch, defaultGroupId?: string) {
    const result = ingestBatch(households.value, dispatch.value, batch, { defaultGroupId });
    if (!result.skipped) enqueue("设备补传", "接收", `${batch.device} / ${result.created.length} 新增 ${result.merged.length} 重复 ${result.conflicts} 冲突`);
    return result;
  }

  function dispatchPipeline(options?: { batch?: IncomingBatch; failAt?: "派工" | "同步送达"; defaultGroupId?: string }) {
    return runDispatch(households.value, dispatch.value, options);
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    resolveEngineConflict(households.value, dispatch.value, id, resolution);
    enqueue("字段冲突", "定稿", `${id} ${resolution}`);
  }

  /** 兼容旧「尝试同步」：模拟一台设备补传，产出字段级冲突供人工处理 */
  function simulateSync() {
    syncing.value = true;
    setTimeout(() => {
      const target = households.value.find((item) => item.id === "h1") ?? households.value[0];
      if (target) {
        ingestBatch(
          households.value,
          dispatch.value,
          {
            batchId: uid("batch"),
            device: "巡检员B-手机",
            items: [
              {
                head: target.head,
                community: target.community,
                address: "河湾路18号2栋2单元",
                members: target.members,
                vulnerable: target.vulnerable,
                needLevel: target.needLevel,
                needs: target.needs,
                note: target.note
              }
            ]
          },
          { defaultGroupId: "g2" }
        );
      }
      lastSyncedAt.value = nowIso();
      syncing.value = false;
    }, 650);
  }

  function groupLoad(groupId: string) {
    return { active: activeCount(dispatch.value, groupId), capacity: dispatch.value.groups.find((item) => item.id === groupId)?.capacity ?? 0 };
  }

  function queuedForGroup(groupId?: string) {
    return queuedReviews(households.value, dispatch.value, groupId);
  }

  if (typeof window !== "undefined") {
    watch([households, tasks, queue, dispatch, lastSyncedAt], () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          households: households.value,
          tasks: tasks.value,
          queue: queue.value,
          dispatch: dispatch.value,
          lastSyncedAt: lastSyncedAt.value
        })
      );
    }, { deep: true });
  }

  return {
    households,
    tasks,
    queue,
    dispatch,
    conflicts,
    online,
    lastSyncedAt,
    syncing,
    metrics,
    duplicates,
    activeRun,
    addHousehold,
    updateHousehold,
    mergeDuplicate,
    addTask,
    advanceTask,
    enqueueReviewTask,
    claim,
    contendLastSlot,
    startReviewTask,
    completeReviewTask,
    changeNeedLevel,
    receiveBatch,
    dispatchPipeline,
    resolveConflict,
    simulateSync,
    groupLoad,
    queuedForGroup,
    enqueue
  };
});
