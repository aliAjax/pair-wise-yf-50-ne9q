<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore, type NeedLevel } from "~/stores/assessment";
import { probeCache } from "~/utils/api";

const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const cacheProbe = ref<{ cachedAt: string; source: string } | null>(null);
const syncMessage = ref("");
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.string().min(1, "请输入家庭人数"), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: "1", needLevel: "一般" as NeedLevel, needs: "", note: "" } });
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

const queueTasks = computed(() => store.queueOrder.map((id) => store.tasks.find((task) => task.id === id)).filter((task) => !!task));
const dispatchedTasks = computed(() => store.tasks.filter((task) => task.status !== "排队中"));

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
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-09-30 18:00" });
}
function changeUrgency(householdId: string, level: NeedLevel) {
  store.setUrgency(householdId, level);
}
async function dispatchAll() {
  await store.processDispatchQueue();
}
async function retryDispatch() {
  await store.retryDispatch();
}
async function race() {
  await store.raceLastSlot();
}
async function sync() {
  if (!store.online) { syncMessage.value = "仍在弱网状态，队列保留在设备中。"; return; }
  syncMessage.value = store.simulateFailure ? "模拟弱网中断，提交到一半会停下。" : "正在按检查点提交离线变更…";
  await store.syncNow();
  if (store.syncError) syncMessage.value = store.syncError;
  else syncMessage.value = "同步完成，待同步队列已清空。";
}
async function retrySync() {
  syncMessage.value = "从检查点继续重试，已提交的不会重发…";
  await store.retrySync();
  if (store.syncError) syncMessage.value = store.syncError;
  else syncMessage.value = "同步完成，待同步队列已清空。";
}
function levelTagType(level: NeedLevel) {
  return level === "紧急" ? "error" : level === "高" ? "warning" : "success";
}
function statusTagType(status: string) {
  return status === "已完成" ? "success" : status === "进行中" ? "info" : status === "已派出" ? "warning" : "default";
}
</script>

<template>
  <div class="shell">
    <aside class="side"><div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div><nav><button v-for="item in ['需求记录', '重复合并', '任务分派', '同步队列', '冲突处理']" :key="item" :class="{ active: panel === item }" @click="panel = item">{{ item }} <span v-if="item === '同步队列' && store.queue.length">({{ store.queue.length }})</span></button></nav><div class="network"><small>设备与网络</small><b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b><NSwitch v-model:value="store.online" /><small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small></div></aside>
    <main>
      <header><div><small>评估批次 2026-09-29 · 河湾片区</small><h1>灾后需求评估与任务分派</h1><p>记录可离线保存，恢复连接后按紧急度派工；冲突未决不占名额，中断后从检查点继续。</p></div><div class="status-chip"><NProgress type="circle" :percentage="100 - store.queue.length * 8" :stroke-width="8" :width="42" /><span>{{ store.queue.length ? `${store.queue.length} 项待同步` : '数据已同步' }}</span></div></header>
      <section class="metrics"><NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard><NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard><NCard><NStatistic label="未完成任务" :value="store.metrics.openTasks" /></NCard><NCard><NStatistic label="本地队列" :value="store.metrics.queued" /></NCard></section>
      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon>当前网络不可用。新增记录与任务仍可操作，所有变更会写入本地缓存与待同步队列；派工在设备侧排队，恢复后按检查点提交。</NAlert>
      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录" :bordered="false"><div class="households"><article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id }" @click="selectedId = item.id"><div><b>{{ item.head }} · {{ item.members }}人</b><small>{{ item.community }} / {{ item.address }}</small><p>{{ item.needs.join('、') }} · {{ item.note }}</p></div><div class="household-tags"><NTag :type="levelTagType(item.needLevel)">{{ item.needLevel }}</NTag><NTag v-if="store.hasUnresolvedConflict(item.id)" type="error" size="small">冲突未决</NTag><small>{{ item.status }} · v{{ item.version }}</small></div></article></div></NCard>
        <NCard title="新增需求记录"><form class="field-grid" @submit.prevent="submit"><label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label><label class="field"><span>社区</span><NInput v-model:value="community" /></label><label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="不使用地图坐标时可描述楼栋与单元" /><small>{{ errors.address }}</small></label><label class="field"><span>家庭人数</span><NInput v-model:value="members" type="number" /></label><label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label><label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label><label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label><div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton><NButton @click="sync">尝试同步</NButton></div></form></NCard>
      </div>
      <NCard v-if="panel === '重复合并'" title="疑似重复记录"><div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate"><b>{{ group[0].head }} · {{ group[0].community }}</b><p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p><NButton type="primary" size="small" @click="store.mergeDuplicate(group[1].id, group[0].id)">合并为一条并保留需求，已派任务迁到保留记录</NButton></div><p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p></NCard>
      <div v-if="panel === '任务分派'" class="page-grid">
        <NCard title="小组名额（每组同时只能接一项现场复核）"><div class="groups"><div v-for="group in store.groups" :key="group.id" class="group" :class="{ free: !group.activeTaskId }"><b>{{ group.name }}</b><span v-if="group.activeTaskId">占用中 · {{ store.tasks.find((t) => t.id === group.activeTaskId)?.title }}</span><span v-else class="free-tag">空闲</span></div></div></NCard>
        <NCard title="待派工队列（未开工，按紧急度排序）">
          <p v-if="!queueTasks.length" class="empty">队列为空。可在下方分派新任务，或到“需求记录”新增家庭后派工。</p>
          <div v-for="task in queueTasks" :key="task.id" class="task-row queued"><div><b>{{ task.title }}</b><small>{{ store.households.find((h) => h.id === task.householdId)?.head }} · {{ task.due }}</small><small v-if="store.hasUnresolvedConflict(task.householdId)" class="conflict-hint">冲突未决，暂不占名额</small></div><NTag :type="levelTagType(task.priority)">{{ task.priority }}</NTag><div class="urgency-actions"><NButton size="tiny" :disabled="task.priority === '紧急'" @click="changeUrgency(task.householdId, '紧急')">升紧急</NButton><NButton size="tiny" :disabled="task.priority === '一般'" @click="changeUrgency(task.householdId, '一般')">降一般</NButton></div></div>
          <div class="actions"><NButton type="primary" :loading="store.isDispatching" @click="dispatchAll">一键派工（按顺序）</NButton><NButton v-if="store.dispatchError" type="warning" @click="retryDispatch">失败后从检查点重试</NButton><NButton @click="race">模拟两人抢占最后一个名额</NButton></div>
          <p v-if="store.dispatchError" class="error-text">{{ store.dispatchError }}</p>
          <p v-if="store.dispatchCheckpoint" class="checkpoint">检查点：已派出 {{ store.tasks.find((t) => t.id === store.dispatchCheckpoint)?.title }}（{{ new Date().toLocaleTimeString('zh-CN') }}）</p>
          <div v-if="store.raceLog.length" class="race-log"><p v-for="(line, index) in store.raceLog" :key="index">{{ line }}</p></div>
        </NCard>
        <NCard title="已派出 / 进行中 / 已完成任务">
          <div v-for="task in dispatchedTasks" :key="task.id" class="task-row"><div><b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b><small>{{ store.households.find((item) => item.id === task.householdId)?.head }} · {{ store.groupName(task.groupId) }} · {{ task.due }}</small></div><NTag :type="statusTagType(task.status)">{{ task.status }}</NTag><NTag :type="levelTagType(task.priority)">{{ task.priority }}</NTag><NButton size="small" :disabled="task.status === '已完成'" @click="store.advanceTask(task.id)">{{ task.status === '已派出' ? '开工' : '完成' }}</NButton></div>
          <p v-if="!dispatchedTasks.length" class="empty">还没有已派出的任务。</p>
        </NCard>
        <NCard title="分派新任务"><p>当前家庭：<b>{{ selected?.head }}</b></p><label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label><label class="field"><span>执行小组（派工时按空闲自动分配）</span><NInput v-model:value="taskAssignee" /></label><NButton type="primary" block :disabled="!selected" @click="assignTask">加入待派工队列</NButton></NCard>
      </div>
      <NCard v-if="panel === '同步队列'" title="待同步操作">
        <p>{{ syncMessage || '恢复连接后按检查点顺序提交，已提交的不会重发。' }}</p>
        <div class="sync-toggle"><NSwitch v-model:value="store.simulateFailure" /><span>模拟弱网中断（提交到一半停下）</span></div>
        <div v-for="item in store.queue" :key="item.id" class="queue-row"><NTag>{{ item.action }}</NTag><span>{{ item.entity }} · {{ item.detail }}</span><small>{{ new Date(item.time).toLocaleTimeString('zh-CN') }}</small></div>
        <p v-if="!store.queue.length" class="empty">待同步队列为空。</p>
        <div class="actions"><NButton type="primary" :loading="store.syncing" @click="sync">人工确认并同步</NButton><NButton v-if="store.syncError" type="warning" @click="retrySync">从检查点重试</NButton></div>
        <p v-if="store.syncError" class="error-text">{{ store.syncError }}</p>
        <p v-if="store.syncCheckpoint" class="checkpoint">同步检查点：{{ store.queue.find((q) => q.id === store.syncCheckpoint) ? '继续提交剩余项' : '已提交到最新检查点' }}</p>
        <small v-if="cacheProbe">数据缓存时间：{{ new Date(cacheProbe.cachedAt).toLocaleTimeString('zh-CN') }}</small>
      </NCard>
      <NCard v-if="panel === '冲突处理'" title="字段级冲突">
        <p>冲突未决的家庭不能派工、不占小组名额；解决后该家庭重新具备派工资格。</p>
        <div class="actions"><NButton size="small" @click="store.seedConflict">模拟一条远端冲突</NButton></div>
        <div v-for="item in store.conflicts" :key="item.id" class="conflict"><b>{{ store.households.find((household) => household.id === item.householdId)?.head }} · {{ item.field }}</b><div class="conflict-values"><div><small>本机记录</small><span>{{ item.localValue }}</span></div><div><small>远端记录</small><span>{{ item.remoteValue }}</span></div></div><div class="actions"><NButton size="small" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用本地')">采用本机</NButton><NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用远端')">采用远端</NButton><NTag>{{ item.status }}</NTag></div></div>
        <p v-if="!store.conflicts.length" class="empty">暂无字段冲突。可点击“模拟一条远端冲突”生成后再处理。</p>
      </NCard>
    </main>
  </div>
</template>
