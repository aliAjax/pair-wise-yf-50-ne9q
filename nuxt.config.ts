export default defineNuxtConfig({
  devtools: { enabled: false },
  compatibilityDate: "2025-07-15",
  modules: ["@pinia/nuxt", "@vueuse/nuxt", "@nuxtjs/i18n"],
  // Naive UI 依赖 @css-render / @juggle/resize-observer 在模块顶层引用 document，
  // SSR 时需要转译，否则服务端渲染报 “document is not defined”。
  build: {
    transpile: ["naive-ui", "vueuc", "@css-render/vue3-ssr", "@juggle/resize-observer"]
  },
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
