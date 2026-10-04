import { setup } from "@css-render/vue3-ssr";

// Naive UI 内部的 css-render 在服务端渲染时会尝试挂载到 document.head，
// 通过 @css-render/vue3-ssr 提供 SSR 适配器，把样式收集起来而不是触碰 document。
export default defineNuxtPlugin((nuxtApp) => {
  if (import.meta.server) setup(nuxtApp.vueApp);
});
