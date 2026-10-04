import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "排队中" | "已派出" | "进行中" | "已完成";

export interface Household {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: NeedLevel;
  needs: string[];
  status: HouseholdStatus;
  version: number;
  deviceUpdatedAt: string;
  note: string;
}

export interface Group {
  id: string;
  name: string;
  activeTaskId: string | null;
}

export interface FieldTask {
  id: string;
  householdId: string;
  groupId: string | null;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
  seq: number;
  dispatchedAt: string | null;
  dispatchKey: string;
}

export interface PendingChange {
  id: string;
  entity: string;
  action: string;
  detail: string;
  time: string;
}

export interface FieldConflict {
  id: string;
  householdId: string;
  field: keyof Household;
  localValue: string;
  remoteValue: string;
  status: "待处理" | "采用本地" | "采用远端";
}

const KEY = "pair-wise-yf-50/assessment";

const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString(), note: "疑似重复登记" }
];

const seedGroups: Group[] = [
  { id: "g1", name: "救援一组", activeTaskId: null },
  { id: "g2", name: "救援二组", activeTaskId: null },
  { id: "g3", name: "后勤二组", activeTaskId: "k1" }
];

const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", groupId: "g3", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00", seq: 1, dispatchedAt: new Date(Date.now() - 30 * 60000).toISOString(), dispatchKey: "seed-k1" }
];

function priorityRank(level: NeedLevel): number {
  return level === "紧急" ? 0 : level === "高" ? 1 : 2;
}

// 派工互斥锁：保证“先到先得”，两人同时抢占同一名额时只有先进入临界区的一方得手。
let dispatchMutex: Promise<unknown> = Promise.resolve();
function withDispatchLock<T>(fn: () => T): Promise<T> {
  const run = dispatchMutex.then(fn, fn);
  dispatchMutex = run.then(() => undefined, () => undefined);
  return run;
}

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = typeof window !== "undefined" && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
  const cloneHousehold = (h: Household): Household => ({ ...h, needs: [...h.needs], vulnerable: [...h.vulnerable] });
  const normalizeTask = (t: Partial<FieldTask>): FieldTask => ({
    id: t.id ?? crypto.randomUUID(),
    householdId: t.householdId ?? "",
    groupId: t.groupId ?? null,
    title: t.title ?? "",
    assignee: t.assignee ?? "待分派",
    priority: t.priority ?? "一般",
    status: t.status === "待接收" ? "排队中" : (t.status ?? "排队中"),
    due: t.due ?? "",
    seq: t.seq ?? 0,
    dispatchedAt: t.dispatchedAt ?? null,
    dispatchKey: t.dispatchKey ?? crypto.randomUUID()
  });
  const households = ref<Household[]>(initial?.households ?? seedHouseholds.map(cloneHousehold));
  const groups = ref<Group[]>(initial?.groups ?? seedGroups.map((g) => ({ ...g })));
  const tasks = ref<FieldTask[]>(initial?.tasks ? initial.tasks.map(normalizeTask) : seedTasks.map((t) => ({ ...t })));
  const queue = ref<PendingChange[]>(initial?.queue ?? []);
  const conflicts = ref<FieldConflict[]>(initial?.conflicts ?? []);
  const queueOrder = ref<string[]>(initial?.queueOrder ?? []);
  const online = ref(true);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? new Date().toISOString());
  const syncing = ref(false);
  const isDispatching = ref(false);
  const simulateFailure = ref(false);
  const dispatchCheckpoint = ref<string | null>(initial?.dispatchCheckpoint ?? null);
  const dispatchError = ref<string | null>(initial?.dispatchError ?? null);
  const syncCheckpoint = ref<string | null>(initial?.syncCheckpoint ?? null);
  const syncError = ref<string | null>(initial?.syncError ?? null);
  const raceLog = ref<string[]>(initial?.raceLog ?? []);

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: queue.value.length
  }));

  const duplicates = computed(() => {
    const groupsMap = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groupsMap.set(key, [...(groupsMap.get(key) ?? []), household]);
    });
    return [...groupsMap.values()].filter((group) => group.length > 1);
  });

  function enqueue(entity: string, action: string, detail: string) {
    queue.value.unshift({ id: crypto.randomUUID(), entity, action, detail, time: new Date().toISOString() });
  }

  function hasUnresolvedConflict(householdId: string): boolean {
    return conflicts.value.some((item) => item.householdId === householdId && item.status === "待处理");
  }

  function freeGroup(): Group | undefined {
    return groups.value.find((group) => group.activeTaskId === null);
  }

  function groupName(groupId: string | null): string {
    return groups.value.find((group) => group.id === groupId)?.name ?? "—";
  }

  // 未开工（排队中）任务按紧急度重排；已派出/进行中的任务已占名额，继续跑，不参与重排。
  function reorderQueue() {
    queueOrder.value = queueOrder.value
      .map((id) => tasks.value.find((task) => task.id === id))
      .filter((task): task is FieldTask => !!task && task.status === "排队中")
      .sort((a, b) => {
        const ha = households.value.find((h) => h.id === a.householdId);
        const hb = households.value.find((h) => h.id === b.householdId);
        return priorityRank(ha?.needLevel ?? a.priority) - priorityRank(hb?.needLevel ?? b.priority) || a.seq - b.seq;
      })
      .map((task) => task.id);
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt">) {
    households.value.unshift({ ...input, id: crypto.randomUUID(), status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString() });
    enqueue("家庭需求记录", "新增", input.head);
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: new Date().toISOString() });
    if (patch.needLevel) reorderQueue();
    enqueue("家庭需求记录", "修改", `${household.head}：${Object.keys(patch).join("、")}`);
  }

  // 紧急度变化：未开工任务按新顺序重排，已开工任务继续跑。
  function setUrgency(householdId: string, level: NeedLevel) {
    const household = households.value.find((item) => item.id === householdId);
    if (!household || household.needLevel === level) return;
    household.needLevel = level;
    household.version += 1;
    household.deviceUpdatedAt = new Date().toISOString();
    // 同步更新该家庭未开工任务的优先级（已派出/进行中的不动）。
    tasks.value.forEach((task) => {
      if (task.householdId === householdId && task.status === "排队中") task.priority = level;
    });
    reorderQueue();
    enqueue("家庭需求记录", "紧急度变更", `${household.head} → ${level}，未开工任务重排`);
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return;
    target.needs = Array.from(new Set([...target.needs, ...source.needs]));
    target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
    target.note = `${target.note}；已合并重复记录 ${source.address}`;
    target.version += 1;
    // 已派任务迁到保留记录，避免任务随重复记录一起丢失。
    tasks.value.forEach((task) => {
      if (task.householdId === sourceId) task.householdId = targetId;
    });
    households.value = households.value.filter((item) => item.id !== sourceId);
    reorderQueue();
    enqueue("重复记录", "合并", `${source.head} → ${target.address}，任务 ${tasks.value.filter((t) => t.householdId === targetId).length} 项已迁到保留记录`);
  }

  function addTask(input: Omit<FieldTask, "id" | "status" | "groupId" | "seq" | "dispatchedAt" | "dispatchKey">) {
    const seq = tasks.value.reduce((max, task) => Math.max(max, task.seq), 0) + 1;
    const task: FieldTask = { ...input, id: crypto.randomUUID(), status: "排队中", groupId: null, seq, dispatchedAt: null, dispatchKey: crypto.randomUUID() };
    tasks.value.unshift(task);
    queueOrder.value.push(task.id);
    reorderQueue();
    enqueue("任务", "排队", `${input.title} / ${input.assignee}`);
  }

  function createQueuedTask(householdId: string, title: string): FieldTask {
    const household = households.value.find((item) => item.id === householdId);
    const seq = tasks.value.reduce((max, task) => Math.max(max, task.seq), 0) + 1;
    const task: FieldTask = {
      id: crypto.randomUUID(),
      householdId,
      groupId: null,
      title,
      assignee: "待分派",
      priority: household?.needLevel ?? "一般",
      status: "排队中",
      due: "2026-09-30 18:00",
      seq,
      dispatchedAt: null,
      dispatchKey: crypto.randomUUID()
    };
    tasks.value.unshift(task);
    queueOrder.value.push(task.id);
    reorderQueue();
    return task;
  }

  // 派一个任务：冲突未决不占名额、名额满了留队列、已派出不重发。
  function dispatchTask(taskId: string, groupId?: string): Promise<{ ok: boolean; reason?: string; groupId?: string }> {
    return withDispatchLock(() => {
      const task = tasks.value.find((item) => item.id === taskId);
      if (!task) return { ok: false, reason: "任务不存在" };
      if (task.status !== "排队中" || task.dispatchedAt) return { ok: false, reason: "任务已派出，不能重发" };
      const household = households.value.find((item) => item.id === task.householdId);
      if (!household) return { ok: false, reason: "家庭不存在" };
      if (household.status === "已完成") return { ok: false, reason: "家庭已完成" };
      if (hasUnresolvedConflict(household.id)) return { ok: false, reason: "家庭冲突未解决，不能占用小组名额" };
      const group = groupId ? groups.value.find((item) => item.id === groupId) : freeGroup();
      if (!group) return { ok: false, reason: "小组名额已满，任务留在队列" };
      if (group.activeTaskId !== null) return { ok: false, reason: "小组名额被占，先到先得" };
      group.activeTaskId = taskId;
      task.groupId = group.id;
      task.assignee = group.name;
      task.status = "已派出";
      task.dispatchedAt = new Date().toISOString();
      queueOrder.value = queueOrder.value.filter((id) => id !== taskId);
      dispatchCheckpoint.value = taskId;
      if (household.status === "待评估" || household.status === "待复核") household.status = "已分派";
      enqueue("任务", "派出", `${task.title} → ${group.name}`);
      return { ok: true, groupId: group.id };
    });
  }

  // 按紧急度顺序把队列里的任务派出去；失败则停在检查点，没派上的留在队列。
  async function processDispatchQueue() {
    isDispatching.value = true;
    dispatchError.value = null;
    const snapshot = [...queueOrder.value];
    for (const taskId of snapshot) {
      const task = tasks.value.find((item) => item.id === taskId);
      if (!task || task.status !== "排队中") continue; // 已派出/已完成：不重发
      const result = await dispatchTask(taskId);
      if (!result.ok) {
        dispatchError.value = result.reason ?? "派工失败";
        break;
      }
    }
    isDispatching.value = false;
  }

  // 失败后从已完成部分继续重试：已派出的不重发，队列里剩下的接着派。
  async function retryDispatch() {
    dispatchError.value = null;
    await processDispatchQueue();
  }

  // 模拟两人同时抢占最后一个名额：先到的一方得手，后到的一方接到“名额被占”。
  async function raceLastSlot() {
    raceLog.value = [];
    while (groups.value.filter((group) => group.activeTaskId === null).length > 1 && queueOrder.value.length) {
      await dispatchTask(queueOrder.value[0]);
    }
    const household = households.value[0];
    const racerA = createQueuedTask(household.id, "抢占任务A");
    const racerB = createQueuedTask(household.id, "抢占任务B");
    const target = freeGroup();
    if (!target) {
      raceLog.value.push("没有空闲名额，两人都留在队列。");
      return;
    }
    const first = await dispatchTask(racerA.id, target.id);
    raceLog.value.push(`先到方：${first.ok ? `已接到任务（${target.name}）` : first.reason}`);
    const second = await dispatchTask(racerB.id, target.id);
    raceLog.value.push(`后到方：${second.ok ? "已接到任务" : second.reason}（同一名额先到先得）`);
  }

  function advanceTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return;
    if (task.status === "已派出") {
      task.status = "进行中";
    } else if (task.status === "进行中") {
      task.status = "已完成";
      const group = groups.value.find((item) => item.activeTaskId === task.id);
      if (group) group.activeTaskId = null;
      const open = tasks.value.some((item) => item.householdId === task.householdId && item.status !== "已完成");
      const household = households.value.find((item) => item.id === task.householdId);
      if (household && !open) household.status = "已完成";
      processDispatchQueue(); // 名额空出，自动补位派下一项
    }
    enqueue("任务", "状态流转", `${task.title} → ${task.status}`);
  }

  // 同步待同步队列：带检查点，中断后从已完成部分继续，已提交的不重发。
  async function syncNow() {
    syncing.value = true;
    syncError.value = null;
    const items = [...queue.value];
    let done = 0;
    for (let index = 0; index < items.length; index += 1) {
      if (simulateFailure.value && index === (items.length > 1 ? 1 : 0)) {
        syncError.value = `同步在第 ${index + 1} 项中断（弱网），已提交 ${done} 项，从检查点继续重试`;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      done += 1;
      syncCheckpoint.value = items[index].id;
      queue.value = queue.value.filter((item) => item.id !== items[index].id); // 已提交，不重发
    }
    syncing.value = false;
    if (!syncError.value) {
      lastSyncedAt.value = new Date().toISOString();
      simulateFailure.value = false;
    }
  }

  async function retrySync() {
    syncError.value = null;
    simulateFailure.value = false;
    await syncNow();
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict) return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    if (household && resolution === "采用远端") (household as unknown as Record<string, unknown>)[conflict.field] = conflict.remoteValue;
    conflict.status = resolution;
    if (household) household.version += 1;
    reorderQueue(); // 冲突解决后，该家庭重新具备占名额资格
  }

  function seedConflict() {
    const first = households.value[0];
    if (!first) return;
    conflicts.value.unshift({ id: crypto.randomUUID(), householdId: first.id, field: "address", localValue: first.address, remoteValue: "河湾路18号2栋2单元", status: "待处理" });
    enqueue("冲突", "标记", `${first.head} address 待处理`);
  }

  if (typeof window !== "undefined") {
    watch([households, groups, tasks, queue, conflicts, queueOrder, lastSyncedAt, dispatchCheckpoint, dispatchError, syncCheckpoint, syncError, raceLog], () => {
      localStorage.setItem(KEY, JSON.stringify({
        households: households.value,
        groups: groups.value,
        tasks: tasks.value,
        queue: queue.value,
        conflicts: conflicts.value,
        queueOrder: queueOrder.value,
        lastSyncedAt: lastSyncedAt.value,
        dispatchCheckpoint: dispatchCheckpoint.value,
        dispatchError: dispatchError.value,
        syncCheckpoint: syncCheckpoint.value,
        syncError: syncError.value,
        raceLog: raceLog.value
      }));
    }, { deep: true });
  }

  return {
    households, groups, tasks, queue, conflicts, queueOrder, online, lastSyncedAt, syncing, isDispatching,
    simulateFailure, dispatchCheckpoint, dispatchError, syncCheckpoint, syncError, raceLog,
    metrics, duplicates,
    hasUnresolvedConflict, freeGroup, groupName, reorderQueue,
    addHousehold, updateHousehold, setUrgency, mergeDuplicate, addTask,
    dispatchTask, processDispatchQueue, retryDispatch, raceLastSlot, advanceTask,
    syncNow, retrySync, resolveConflict, seedConflict, enqueue
  };
});
