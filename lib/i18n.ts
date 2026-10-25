// Bilingual copy for the surfaces this product ships in Spanish and English
// for. Spanish is the default: it is the market this SaaS is aimed at first,
// with English as the equal second. Add a key to `en`, then to `es` — the
// `Dictionary` type below fails the build if a locale falls behind.

export const locales = ["es", "en"] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = "es"

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (locales as readonly string[]).includes(value)
}

// No `as const`: the values must be plain strings so `es` can carry different
// wording while still being checked against the same shape.
const en = {
  brand: "Paradox",
  nav: {
    agent: "Agent",
    panels: "Panels",
    automations: "Automations",
    integrations: "Integrations",
    activity: "Activity",
    settings: "Settings",
    pricing: "Pricing",
    usage: "Usage",
    signIn: "Sign in",
    signUp: "Get started",
    openApp: "Open app",
    backToApp: "Back to the app",
    signedIn: "You are signed in — this is the public page.",
    language: "Language",
  },
  hero: {
    title: "Paradox",
    highlight: "Your AI that works for you.",
    ctaPrimary: "Create your agent free",
    ctaSecondary: "See how it works",
  },
  trust: {
    eyebrow: "Built for people who delegate, not for people who prompt",
    stats: [
      { value: "16+", label: "social networks in one API" },
      { value: "<60s", label: "to create your first agent" },
      { value: "4", label: "agents ready on day one" },
      { value: "24/7", label: "browser + sandbox execution" },
    ],
  },
  pain: {
    eyebrow: "Sound familiar?",
    title: "AI that writes a lot and does little is costing you hours.",
    description:
      "Copying between tabs, repeating instructions, checking if something actually ran. Paradox removes that friction.",
    items: [
      {
        title: "Tab-switching fatigue",
        description: "Chat here, automate there, publish elsewhere. Every jump loses context and time.",
      },
      {
        title: "Prompts with no proof",
        description: "Pretty text, zero execution. No logs, no recording, no way to trust what happened.",
      },
      {
        title: "Automations only devs understand",
        description: "Nodes and webhooks that die on Monday. You need blocks you can watch run.",
      },
    ],
  },
  solutions: {
    eyebrow: "One place, three powers",
    title: "Everything the product does, as agents you talk to.",
    sub: "Start in chat. Scale to agents. Automate with workflows. Same brain, three speeds.",
  },
  sections: [
    {
      name: "Chat",
      title: "One chat. Every agent.",
      description:
        "A chat that looks like the AI chats you already know and runs on a real agent backend: models with skills, a sandbox, memory across conversations and a router that chooses the agent for you.",
      points: [
        "Text, images and files in the same box",
        "The agent is chosen automatically, never by you",
        "Output shaped as markdown, JSON, table or email",
      ],
    },
    {
      name: "Agents",
      title: "Your catalogue of agents.",
      description:
        "The defaults ship ready to work. Build your own by hand, or describe what you need and let the AI write it. Then delegate a task to a specific agent in its own conversation.",
      points: [
        "Default agents for chat, browser, PC and social",
        "Create manually or let the AI draft it",
        "Talk to one agent directly when you know who fits",
      ],
    },
    {
      name: "Workflows",
      title: "Blocks that run agents.",
      description:
        "Connect blocks on a canvas and let them execute in order: browse, extract, run an agent, publish to social or send an email. Watch every node live and replay the browser session afterwards.",
      points: [
        "Drag, connect, validate and run",
        "Live status, timing and logs per node",
        "Browser recordings for every run",
      ],
    },
  ],
  capabilities: {
    title: "The hands of the operation",
    sub: "Behind every conversation there are real execution engines — not just text generation.",
    items: [
      {
        title: "Browser agent",
        description:
          "Playwright-backed control of a cloud browser: navigate, click, type, read and screenshot, with a recording of every session.",
      },
      {
        title: "PC agent",
        description:
          "PyAutoGUI control of a desktop — the cloud sandbox you get by default, or the agent you install on your own computer.",
      },
      {
        title: "Social agent",
        description:
          "One API for 16 networks: schedule, publish and track posts to Instagram, X, LinkedIn, TikTok, YouTube and more.",
      },
    ],
  },
  how: {
    eyebrow: "From words to done in 4 steps",
    title: "How it works",
    sub: "No setup calls. No code. Describe it once, watch it run.",
    steps: [
      {
        title: "Describe the task",
        description: "Type it, or attach an image or a file. Nothing else.",
      },
      {
        title: "The router picks",
        description:
          "An agent is selected for the job and gets only the tools it needs.",
      },
      {
        title: "It runs",
        description: "Sandbox, browser, desktop or social APIs execute it.",
      },
      {
        title: "You get the shape you asked for",
        description: "Markdown, JSON, a table, an email — your call.",
      },
    ],
  },
  cta: {
    title: "Put an agent on it.",
    description:
      "Create your first agent in under a minute. The defaults are ready the moment you sign in.",
    button: "Create your first agent",
    micro: "Free to start · No credit card · Cancel anytime",
  },
  faq: {
    eyebrow: "Questions, answered",
    title: "Everything else you are wondering.",
    items: [
      {
        q: "Do I need to know how to prompt?",
        a: "No. Describe the outcome in plain words — the router picks the right agent and gives it only the tools it needs.",
      },
      {
        q: "How is this different from a normal AI chat?",
        a: "Normal chats write. Paradox executes: real browsers, a real desktop sandbox, social APIs — with logs and session recordings as proof.",
      },
      {
        q: "Can I see what the agent actually did?",
        a: "Yes. Every workflow node shows live status, timing and logs, and browser runs include a replayable recording.",
      },
      {
        q: "What does free include?",
        a: "You start free with no credit card, including two connected social accounts so you can feel the full loop on day one.",
      },
    ],
  },
  finalCta: {
    title: "Your next task could already be done.",
    description: "Join Paradox and delegate it to an agent in the next 60 seconds.",
    button: "Start free now",
    micro: "No credit card required",
  },
  scroll: {
    title: "See the product",
    highlight: "in motion.",
  },
  footer: {
    tagline:
      "AI agents with a job, the tools to do it, and an answer you can use.",
    product: "Product",
    company: "Company",
    terms: "Terms",
    privacy: "Privacy",
    rights: "All rights reserved.",
  },
  agents: {
    title: "Agents",
    subtitle:
      "Everything the product can do, as agents you can talk to. Pick a default, build your own, or let the AI write one for you.",
    create: "New agent",
    createWithAi: "Create with AI",
    empty: "No agents yet",
    emptyDescription:
      "Start from a default, describe the agent you need, or pick one of the product’s defaults below.",
    chat: "Chat",
    kind: {
      chat: "Chat",
      browser: "Browser",
      computer: "PC",
      social: "Social",
    },
    source: {
      default: "Default",
      user: "Yours",
      ai: "AI-made",
    },
    talkTo: "Open chat",
    tasks: "tasks",
    nameLabel: "Name (optional)",
    nameHint: "Leave it blank and the AI picks one that fits the job.",
    descriptionLabel: "What should this agent do?",
    descriptionHint:
      "Describe the job, who it serves and how it should answer. The AI writes the rest.",
    descriptionPlaceholder:
      "A Spanish-speaking support agent that answers with a short table of order status and asks before refunding.",
    capabilities: "Capabilities",
    edit: "Edit",
  },
  common: {
    cancel: "Cancel",
    save: "Save",
    delete: "Delete",
    create: "Create",
    loading: "Loading…",
  },
  widgets: {
    title: "Widgets",
    subtitle: "Live blocks you can place on your dashboard.",
    create: "Create widget",
    edit: "Edit",
    publish: "Publish",
    disable: "Disable",
    delete: "Delete",
    empty: "No widgets yet",
    emptyDescription: "Create your first widget to personalize your dashboard.",
    nameLabel: "Name",
    typeLabel: "Type",
    configLabel: "Configuration",
    published: "Published",
    draft: "Draft",
    save: "Save",
    cancel: "Cancel",
  },
  workspace: {
    title: "Workspace",
    subtitle: "Your personal workspace",
    agentChat: "Agent Chat",
    socialPlanner: "Social Planner",
    workoutTracker: "Workout Tracker",
    open: "Open",
  },
}

export type Dictionary = typeof en

// Fails to compile if a key is missing or has drifted, so a translation can't
// silently fall back to English.
const es: Dictionary = {
  brand: "Paradox",
  nav: {
    agent: "Agente",
    panels: "Paneles",
    automations: "Automatizaciones",
    integrations: "Integraciones",
    activity: "Actividad",
    settings: "ConfiguraciÃ³n",
    pricing: "Precios",
    usage: "Uso",
    signIn: "Iniciar sesión",
    signUp: "Empezar",
    openApp: "Abrir app",
    backToApp: "Volver a la app",
    signedIn: "Tienes la sesión iniciada: esta es la página pública.",
    language: "Idioma",
  },
  hero: {
    title: "Paradox",
    highlight: "Tu IA que trabaja por ti.",
    ctaPrimary: "Crea tu agente gratis",
    ctaSecondary: "Ver cómo funciona",
  },
  trust: {
    eyebrow: "Hecho para quien delega, no para quien escribe prompts",
    stats: [
      { value: "16+", label: "redes sociales en una sola API" },
      { value: "<60s", label: "para crear tu primer agente" },
      { value: "4", label: "agentes listos desde el día uno" },
      { value: "24/7", label: "ejecución en navegador + sandbox" },
    ],
  },
  pain: {
    eyebrow: "¿Te suena?",
    title: "La IA que escribe mucho y hace poco te cuesta horas.",
    description:
      "Copiar entre pestañas, repetir instrucciones, comprobar si algo realmente se ejecutó. Paradox elimina esa fricción.",
    items: [
      {
        title: "Fatiga de pestañas",
        description: "Chatea aquí, automatiza allá, publica en otro lado. Cada salto pierde contexto y tiempo.",
      },
      {
        title: "Prompts sin pruebas",
        description: "Texto bonito, cero ejecución. Sin registros, sin grabación, sin forma de confiar.",
      },
      {
        title: "Automatizaciones solo para devs",
        description: "Nodos y webhooks que mueren el lunes. Necesitas bloques que puedes ver ejecutarse.",
      },
    ],
  },
  solutions: {
    eyebrow: "Un lugar, tres poderes",
    title: "Todo lo que hace el producto, como agentes con los que hablas.",
    sub: "Empieza en el chat. Escala a agentes. Automatiza con flujos. El mismo cerebro, tres velocidades.",
  },
  sections: [
    {
      name: "Chat",
      title: "Un chat. Todos los agentes.",
      description:
        "Un chat con la cara que ya conoces, pero con un backend de agentes de verdad: modelos con habilidades, un sandbox, memoria entre conversaciones y un enrutador que elige el agente por ti.",
      points: [
        "Texto, imágenes y archivos en el mismo campo",
        "El agente se elige solo, nunca lo eliges tú",
        "Salida en markdown, JSON, tabla o correo",
      ],
    },
    {
      name: "Agents",
      title: "Tu catálogo de agentes.",
      description:
        "Los agentes por defecto llegan listos para trabajar. Crea los tuyos a mano o descríbe lo que necesitas y deja que la IA lo escriba. Después delega una tarea a un agente concreto en su propia conversación.",
      points: [
        "Agentes por defecto para chat, navegador, PC y redes",
        "Crea manualmente o deja que la IA lo redacte",
        "Habla con un agente directo cuando ya sabes quién encaja",
      ],
    },
    {
      name: "Flujos",
      title: "Bloques que ejecutan agentes.",
      description:
        "Conecta bloques en un lienzo y déjalos ejecutar en orden: navegar, extraer, lanzar un agente, publicar en redes o enviar un correo. Mira cada nodo en vivo y reproduce la sesión del navegador al terminar.",
      points: [
        "Arrastra, conecta, valida y ejecuta",
        "Estado, tiempos y registros de cada nodo en vivo",
        "Grabación del navegador en cada ejecución",
      ],
    },
  ],
  capabilities: {
    title: "Las manos de la operación",
    sub: "Detrás de cada conversación hay motores de ejecución reales — no solo generación de texto.",
    items: [
      {
        title: "Agente de navegador",
        description:
          "Control con Playwright de un navegador en la nube: navega, haz clic, escribe, lee y captura, con grabación de cada sesión.",
      },
      {
        title: "Agente de PC",
        description:
          "Control con PyAutoGUI de un escritorio: el sandbox en la nube que ya tienes, o el agente que instalas en tu propio equipo.",
      },
      {
        title: "Agente de redes",
        description:
          "Una sola API para 16 redes: programa, publica y mide en Instagram, X, LinkedIn, TikTok, YouTube y más.",
      },
    ],
  },
  how: {
    eyebrow: "De palabras a hecho en 4 pasos",
    title: "Cómo funciona",
    sub: "Sin llamadas de setup. Sin código. Descríbelo una vez, míralo ejecutarse.",
    steps: [
      {
        title: "Describe la tarea",
        description: "Escríbela o adjunta una imagen o un archivo. Nada más.",
      },
      {
        title: "El enrutador elige",
        description:
          "Se selecciona un agente para el trabajo y recibe solo las herramientas que necesita.",
      },
      {
        title: "Se ejecuta",
        description: "Sandbox, navegador, escritorio o APIs de redes la hacen.",
      },
      {
        title: "Recibes la forma que pediste",
        description: "Markdown, JSON, una tabla, un correo: tú decides.",
      },
    ],
  },
  cta: {
    title: "Delega la tarea a un agente.",
    description:
      "Crea tu primer agente en menos de un minuto. Los por defecto están listos nada más entrar.",
    button: "Crear tu primer agente",
    micro: "Gratis para empezar · Sin tarjeta · Cancela cuando quieras",
  },
  faq: {
    eyebrow: "Preguntas, respondidas",
    title: "Todo lo demás que te preguntas.",
    items: [
      {
        q: "¿Necesito saber escribir prompts?",
        a: "No. Describe el resultado en palabras normales — el enrutador elige el agente adecuado y le da solo las herramientas que necesita.",
      },
      {
        q: "¿En qué se diferencia de un chat de IA normal?",
        a: "Los chats normales escriben. Paradox ejecuta: navegadores reales, un sandbox de escritorio real, APIs de redes — con registros y grabaciones como prueba.",
      },
      {
        q: "¿Puedo ver lo que hizo el agente?",
        a: "Sí. Cada nodo del flujo muestra estado en vivo, tiempos y registros, y las ejecuciones de navegador incluyen una grabación reproducible.",
      },
      {
        q: "¿Qué incluye lo gratis?",
        a: "Empiezas gratis sin tarjeta, con dos cuentas sociales conectadas para sentir el ciclo completo desde el día uno.",
      },
    ],
  },
  finalCta: {
    title: "Tu próxima tarea ya podría estar hecha.",
    description: "Únete a Paradox y delégala a un agente en los próximos 60 segundos.",
    button: "Empezar gratis ahora",
    micro: "Sin tarjeta requerida",
  },
  scroll: {
    title: "Mira el producto",
    highlight: "en movimiento.",
  },
  footer: {
    tagline:
      "Agentes de IA con un trabajo, las herramientas para hacerlo y una respuesta que puedes usar.",
    product: "Producto",
    company: "Compañía",
    terms: "Términos",
    privacy: "Privacidad",
    rights: "Todos los derechos reservados.",
  },
  agents: {
    title: "Agents",
    subtitle:
      "Todo lo que puede hacer el producto, como agentes con los que hablar. Elige uno por defecto, crea el tuyo o deja que la IA escriba uno.",
    create: "Nuevo agente",
    createWithAi: "Crear con IA",
    empty: "Aún no hay agentes",
    emptyDescription:
      "Empieza con uno por defecto, describe el agente que necesitas o elige uno de los por defecto del producto abajo.",
    chat: "Chat",
    kind: {
      chat: "Chat",
      browser: "Navegador",
      computer: "PC",
      social: "Redes",
    },
    source: {
      default: "Por defecto",
      user: "Tuyo",
      ai: "Creado por IA",
    },
    talkTo: "Abrir chat",
    tasks: "tareas",
    nameLabel: "Nombre (opcional)",
    nameHint: "Déjalo en blanco y la IA elige uno acorde al trabajo.",
    descriptionLabel: "¿Qué debe hacer este agente?",
    descriptionHint:
      "Describe el trabajo, a quién sirve y cómo debe responder. La IA escribe lo demás.",
    descriptionPlaceholder:
      "Un agente de soporte en español que responde con una tabla corta del estado de los pedidos y pide confirmación antes de reembolsar.",
    capabilities: "Capacidades",
    edit: "Editar",
  },
  common: {
    cancel: "Cancelar",
    save: "Guardar",
    delete: "Eliminar",
    create: "Crear",
    loading: "Cargando…",
  },
  widgets: {
    title: "Widgets",
    subtitle: "Bloques dinámicos para tu panel de control.",
    create: "Crear widget",
    edit: "Editar",
    publish: "Publicar",
    disable: "Desactivar",
    delete: "Eliminar",
    empty: "Aún no hay widgets",
    emptyDescription: "Crea tu primer widget para personalizar tu panel.",
    nameLabel: "Nombre",
    typeLabel: "Tipo",
    configLabel: "Configuración",
    published: "Publicado",
    draft: "Borrador",
    save: "Guardar",
    cancel: "Cancelar",
  },
  workspace: {
    title: "Workspace",
    subtitle: "Tu entorno de trabajo personal",
    agentChat: "Agent Chat",
    socialPlanner: "Social Planner",
    workoutTracker: "Workout Tracker",
    open: "Abrir",
  },
}

export const dictionaries: Record<Locale, Dictionary> = { en, es }
