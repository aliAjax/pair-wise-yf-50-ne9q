export default defineNuxtConfig({
  // 弱网离线工具，纯客户端 SPA：Naive UI 依赖 document，localStorage 状态也只在浏览器侧
  ssr: false,
  devtools: { enabled: false },
  compatibilityDate: "2025-07-15",
  modules: ["@pinia/nuxt", "@vueuse/nuxt", "@nuxtjs/i18n"],
  css: ["~/assets/main.css"],
  i18n: {
    locales: [{ code: "zh", language: "zh-CN", name: "中文", file: "zh.json" }],
    defaultLocale: "zh",
    strategy: "no_prefix",
    langDir: "locales",
    bundle: { optimizeTranslationDirective: false }
  },
  app: {
    head: {
      title: "灾后需求评估与任务分派",
      meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }]
    }
  }
});
