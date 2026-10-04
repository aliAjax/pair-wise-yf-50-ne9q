<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore } from "~/stores/assessment";
import type { NeedLevel } from "~/utils/dispatch";
import { probeCache } from "~/utils/api";

const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const cacheProbe = ref<{ cachedAt: string; source: string } | null>(null);
const syncMessage = ref("");
const pipelineMessage = ref("");
const contenderResult = ref<string[]>([]);
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.coerce.number().min(1).max(30), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: 1, needLevel: "一般" as NeedLevel, needs: "", note: "" } });
const [head] = defineField("head");
const [community] = defineField("community");
const [address] = defineField("address");
const [members] = defineField("members");
const [needLevel] = defineField("needLevel");
const [needs] = defineField("needs");
const [note] = defineField("note");
const selected = computed(() => store.households.find((item) => item.id === selectedId.value) ?? store.households[0]);
const taskAssignee = ref("救援一组");
const taskTitle = ref("现场复核");

const levelOptions = [
  { value: "紧急", label: "紧急" },
  { value: "高", label: "高" },
  { value: "一般", label: "一般" }
];
const repriorityId = ref(store.households[0]?.id ?? "");
const repriorityOptions = computed(() =>
  store.households.map((item) => ({ value: item.id, label: `${item.head}（当前：${item.needLevel}）` }))
);

onMounted(async () => {
  cacheProbe.value = await probeCache();
  store.online = browserOnline.value;
});
const submit = handleSubmit((values) => {
  store.addHousehold({ head: values.head, community: values.community, address: values.address, members: Number(values.members), vulnerable: [], needLevel: values.needLevel as NeedLevel, needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note });
  resetForm();
});
function assignTask() {
  if (!selected.value) return;
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-10-06 18:00" });
}
function sync() {
  if (!store.online) { syncMessage.value = "仍在弱网状态，队列保留在设备中。"; return; }
  syncMessage.value = "正在人工合并离线变更…";
  store.simulateSync();
  setTimeout(() => { syncMessage.value = "同步完成，已发现字段冲突，请在冲突处理定稿；未定稿家庭冻结，不能占用名额。"; }, 800);
}

function householdHead(id: string) {
  return store.households.find((item) => item.id === id)?.head ?? id;
}
function householdBlocked(id: string) {
  return Boolean(store.households.find((item) => item.id === id)?.blocked);
}
const STATUS_TYPE: Record<string, "default" | "info" | "warning" | "success" | "error"> = {
  排队: "warning",
  已派出: "info",
  进行中: "error",
  已完成: "success"
};

const STEP_KEYS = ["接收补传", "冲突冻结", "派工", "同步送达"] as const;
function checkpointDone(step: (typeof STEP_KEYS)[number]) {
  return store.activeRun?.checkpoints[step] ?? false;
}

/** 负责人一边派任务一边收到其他设备补传：补传含重复家庭 → 字段冲突冻结 */
function receiveIncoming() {
  const result = store.receiveBatch(
    {
      device: "巡检员C-PDA",
      items: [
        { head: "李秀兰", community: "河湾社区", address: "河湾路42号（临时医疗点）", members: 3, vulnerable: ["孕妇", "婴幼儿"], needLevel: "紧急", needs: ["医疗转运", "氧气袋"], note: "已开始宫缩" },
        { head: "周阿婆", community: "堤北社区", address: "堤北新村2排7号", members: 1, vulnerable: ["老人"], needLevel: "一般", needs: ["应急食品"] }
      ]
    },
    "g2"
  );
  pipelineMessage.value = result.skipped
    ? "该批次已处理过，整批跳过（断点重放不重复入库）。"
    : `补传完成：新增 ${result.created.length} 户、重复 ${result.merged.length} 户、待处理冲突 ${result.conflicts} 个；冲突家庭已冻结。`;
}

function runPipeline(failAt?: "派工" | "同步送达") {
  const run = store.dispatchPipeline({ failAt, defaultGroupId: "g2" });
  if (run.status === "失败") {
    pipelineMessage.value = `流水线中断于「${run.error}」。检查点：${Object.entries(run.checkpoints).filter(([, v]) => v).map(([k]) => k).join("、") || "无"}；点击「从断点继续」。`;
  } else {
    pipelineMessage.value = "四个检查点全部完成：接收补传 → 冲突冻结 → 派工 → 同步送达。已派出任务未重发、已送达请求未重发。";
  }
}

function repriority(level: NeedLevel) {
  if (!repriorityId.value) return;
  store.changeNeedLevel(repriorityId.value, level);
}

/** 两人同时抢占复核一组最后一个名额：只按到达时间，先到者得 */
function raceLastSlot() {
  const wang = store.households.find((item) => item.head === "王建国");
  const chen = store.households.find((item) => item.head === "陈守义");
  if (!wang || !chen) return;
  const base = Date.now();
  const results = store.contendLastSlot([
    { groupId: "g1", householdId: chen.id, actor: "外勤甲（陈守义单）", arrivedAt: new Date(base - 2000).toISOString() },
    { groupId: "g1", householdId: wang.id, actor: "外勤乙（王建国单）", arrivedAt: new Date(base - 1000).toISOString() }
  ]);
  contenderResult.value = results.map((item) => {
    const prefix = `${item.actor} · ${new Date(item.arrivedAt).toLocaleTimeString("zh-CN")}`;
    return item.ok ? `${prefix} → 抢到名额，任务已派出` : `${prefix} → ${item.reason}`;
  });
}
</script>

<template>
  <div class="shell">
    <aside class="side"><div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div><nav><button v-for="item in ['需求记录', '重复合并', '恢复派工', '任务分派', '同步队列', '冲突处理']" :key="item" :class="{ active: panel === item }" @click="panel = item">{{ item }} <span v-if="item === '同步队列' && store.queue.length">({{ store.queue.length }})</span><span v-if="item === '冲突处理' && store.conflicts.length">({{ store.conflicts.length }})</span></button></nav><div class="network"><small>设备与网络</small><b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b><NSwitch v-model:value="store.online" /><small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small></div></aside>
    <main>
      <header><div><small>评估批次 2026-10-04 · 河湾片区</small><h1>灾后需求评估与任务分派</h1><p>恢复分组作业：每组同时只接一项现场复核，派工处理可从断点继续。</p></div><div class="status-chip"><NProgress type="circle" :percentage="100 - store.queue.length * 8" :stroke-width="8" :width="42" /><span>{{ store.queue.length ? `${store.queue.length} 项待同步` : '数据已同步' }}</span></div></header>
      <section class="metrics"><NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard><NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard><NCard><NStatistic label="排队复核" :value="store.metrics.queuedReviews" /></NCard><NCard><NStatistic label="本地队列" :value="store.metrics.queued" /></NCard></section>
      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon>当前网络不可用。新增记录与派工仍可操作，所有变更会写入本地缓存与待同步队列，恢复后按检查点继续。</NAlert>
      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录" :bordered="false"><div class="households"><article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id }" @click="selectedId = item.id"><div><b>{{ item.head }} · {{ item.members }}人</b><small>{{ item.community }} / {{ item.address }}</small><p>{{ item.needs.join('、') }} · {{ item.note }}</p></div><div class="tags-col"><NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag><NTag v-if="item.blocked" type="error">冲突冻结</NTag><small>{{ item.status }} · v{{ item.version }}</small></div></article></div></NCard>
        <NCard title="新增需求记录"><form class="field-grid" @submit.prevent="submit"><label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label><label class="field"><span>社区</span><NInput v-model:value="community" /></label><label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="不使用地图坐标时可描述楼栋与单元" /><small>{{ errors.address }}</small></label><label class="field"><span>家庭人数</span><NInput v-model:value="members" type="number" /></label><label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="levelOptions" /></label><label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label><label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label><div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton><NButton @click="sync">尝试同步</NButton></div></form></NCard>
      </div>
      <NCard v-if="panel === '重复合并'" title="疑似重复记录"><div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate"><b>{{ group[0].head }} · {{ group[0].community }}</b><p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p><NButton type="primary" size="small" @click="store.mergeDuplicate(group[1].id, group[0].id)">只保留一条并迁移已派任务</NButton></div><p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。设备补传遇到重复时会自动保留一条并生成字段冲突。</p></NCard>

      <div v-if="panel === '恢复派工'" class="dispatch-page">
        <NCard title="可恢复的派工处理" :bordered="false">
          <div class="actions" style="margin-bottom:10px">
            <NButton size="small" @click="receiveIncoming">① 接收其他设备补传</NButton>
            <NButton size="small" type="primary" @click="runPipeline()">② 运行派工流水线</NButton>
            <NButton size="small" type="warning" @click="runPipeline('派工')">③ 派工中崩溃（注入故障）</NButton>
            <NButton size="small" type="error" @click="runPipeline('同步送达')">④ 送达时弱网中断</NButton>
            <NButton size="small" :disabled="!store.activeRun" @click="runPipeline()">从断点继续</NButton>
          </div>
          <p class="hint">{{ pipelineMessage || '四步检查点：接收补传 → 冲突冻结 → 派工 → 同步送达。任一步中断后重试只补做未完成步骤。' }}</p>
          <div v-if="store.activeRun" class="run-strip">
            <NTag v-for="step in STEP_KEYS" :key="step" :type="checkpointDone(step) ? 'success' : 'default'">
              {{ step }}{{ checkpointDone(step) ? ' ✓' : ' …' }}
            </NTag>
            <small>{{ store.activeRun.error }}</small>
          </div>
        </NCard>

        <div class="page-grid">
          <div class="side-stack">
            <NCard v-for="group in store.dispatch.groups" :key="group.id" :title="`${group.name}（同时在办 ${store.groupLoad(group.id).active}/${store.groupLoad(group.id).capacity}）`">
              <div v-for="review in store.dispatch.reviews.filter((r) => r.groupId === group.id && r.status !== '已完成')" :key="review.id" class="review-row">
                <div>
                  <b>{{ householdHead(review.householdId) }} · {{ review.title }}</b>
                  <small>#{{ review.seq }} 入队 · {{ review.enqueuedAt ? new Date(review.enqueuedAt).toLocaleTimeString('zh-CN') : '' }}</small>
                  <small v-if="review.lastReason" class="reason">{{ review.lastReason }}</small>
                </div>
                <NTag :type="review.priority === '紧急' ? 'error' : review.priority === '高' ? 'warning' : 'default'">{{ review.priority }}</NTag>
                <NTag :type="STATUS_TYPE[review.status]">{{ review.status }}</NTag>
                <NTag v-if="householdBlocked(review.householdId)" type="error">冲突冻结</NTag>
                <span class="row-actions">
                  <NButton size="tiny" :disabled="review.status !== '已派出'" @click="store.startReviewTask(review.id)">开工</NButton>
                  <NButton size="tiny" :disabled="review.status === '排队'" @click="store.completeReviewTask(review.id)">完成并释放名额</NButton>
                </span>
              </div>
              <p class="empty" v-if="!store.dispatch.reviews.some((r) => r.groupId === group.id && r.status !== '已完成')">暂无在办或排队任务。</p>
              <small class="hint">该组队列顺序（紧急优先、同级先到先得）：{{ store.queuedForGroup(group.id).map((r) => householdHead(r.householdId)).join(' → ') || '空' }}</small>
            </NCard>
          </div>

          <div class="side-stack">
            <NCard title="紧急度变化 → 重排未开工任务">
              <div class="field"><span>选择家庭调整紧急度</span><NSelect v-model:value="repriorityId" :options="repriorityOptions" /></div>
              <div class="actions" style="margin-top:8px">
                <NButton v-for="level in ['紧急', '高', '一般']" :key="level" size="small" @click="repriority(level as NeedLevel)">升/降为{{ level }}</NButton>
              </div>
              <p class="hint">只重排「排队」任务；已派出、进行中的任务继续跑，顺序不动。</p>
            </NCard>

            <NCard title="两人同时抢最后一个名额">
              <p class="hint">先在左侧把复核一组进行中的任务「完成」释放出唯一名额，再模拟两人同时抢占（陈守义单先到 1 秒，王建国更紧急但后到）。</p>
              <NButton size="small" type="primary" block @click="raceLastSlot">模拟同时抢占</NButton>
              <div v-for="(line, index) in contenderResult" :key="index" class="race-line"><NTag size="small" :type="line.includes('抢到') ? 'success' : 'error'">{{ line.includes('抢到') ? '接到任务' : '抢占失败' }}</NTag><span>{{ line }}</span></div>
            </NCard>

            <NCard title="待同步发件箱（幂等送达）">
              <div v-for="item in store.dispatch.outbox" :key="item.id" class="queue-row">
                <NTag :type="item.sent ? 'success' : 'warning'">{{ item.sent ? '已送达' : '待同步' }}</NTag>
                <span>{{ item.detail }}</span><small>{{ item.requestId.slice(-8) }}</small>
              </div>
              <p v-if="!store.dispatch.outbox.length" class="empty">还没有派出过任务。</p>
            </NCard>
          </div>
        </div>

        <NCard title="处理日志与检查点">
          <div v-for="entry in store.dispatch.log.slice(0, 12)" :key="entry.id" class="log-row">
            <NTag size="small">{{ entry.kind }}</NTag><span>{{ entry.message }}</span><small>{{ new Date(entry.time).toLocaleTimeString('zh-CN') }}</small>
          </div>
          <details v-if="store.dispatch.journals.length">
            <summary>流水线检查点记录（{{ store.dispatch.journals.length }} 次运行）</summary>
            <div v-for="run in store.dispatch.journals.slice(0, 5)" :key="run.runId" class="journal">
              <b>{{ run.runId.slice(-6) }} · {{ run.status }}</b>
              <p v-for="(j, i) in run.journal" :key="i" :class="{ failed: !j.ok }">{{ j.step }}：{{ j.message }}</p>
            </div>
          </details>
        </NCard>
      </div>

      <div v-if="panel === '任务分派'" class="page-grid"><NCard title="任务列表"><div v-for="task in store.tasks" :key="task.id" class="task-row"><div><b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b><small>{{ store.households.find((item) => item.id === task.householdId)?.head }} · {{ task.due }}</small></div><NTag>{{ task.priority }}</NTag><span>{{ task.assignee }} · {{ task.status }}</span><NButton size="small" :disabled="task.status === '已完成'" @click="store.advanceTask(task.id)">推进状态</NButton></div></NCard><NCard title="分派新任务（后勤等非复核任务）"><p>当前家庭：<b>{{ selected?.head }}</b></p><label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label><label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label><NButton type="primary" block :disabled="!selected" @click="assignTask">加入任务并本地排队</NButton><p class="hint">现场复核的分组派工请使用「恢复派工」面板，受小组容量约束。</p></NCard></div>
      <NCard v-if="panel === '同步队列'" title="待同步操作"><p>{{ syncMessage || '恢复连接后按顺序提交，冲突不会自动覆盖；已派出的派工请求按 requestId 幂等，不重发。' }}</p><div v-for="item in store.queue" :key="item.id" class="queue-row"><NTag>{{ item.action }}</NTag><span>{{ item.entity }} · {{ item.detail }}</span><small>{{ new Date(item.time).toLocaleTimeString('zh-CN') }}</small></div><p v-if="!store.queue.length" class="empty">待同步队列为空。</p><NButton type="primary" :loading="store.syncing" @click="sync">人工确认并同步</NButton><small v-if="cacheProbe"> 数据缓存时间：{{ new Date(cacheProbe.cachedAt).toLocaleTimeString('zh-CN') }}</small></NCard>
      <NCard v-if="panel === '冲突处理'" title="字段级冲突（未定稿的家庭冻结，不占名额）"><div v-for="item in store.conflicts" :key="item.id" class="conflict"><b>{{ store.households.find((household) => household.id === item.householdId)?.head }} · {{ item.fieldLabel }}（来自 {{ item.sourceDevice }}）</b><div class="conflict-values"><div><small>本机记录</small><span>{{ item.localValue }}</span></div><div><small>补传记录</small><span>{{ item.remoteValue }}</span></div></div><div class="actions"><NButton size="small" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用本地')">采用本机</NButton><NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用远端')">采用远端</NButton><NTag :type="item.status === '待处理' ? 'error' : 'success'">{{ item.status }}</NTag></div></div><p v-if="!store.conflicts.length" class="empty">暂无字段冲突。可在「恢复派工」接收补传，或在需求页点击“尝试同步”模拟多人合并。</p></NCard>
    </main>
  </div>
</template>
