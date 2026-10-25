import { createDocument, type PanelDocument } from "@/lib/panels/document"

// Starting points for the create flow. They carry structure only — sections,
// fields and columns — never results, counters or "recent activity" that would
// look like real data before the person has added any.
export type PanelTemplate = {
  id: string
  name: string
  description: string
  document: PanelDocument
}

export const panelTemplates: PanelTemplate[] = [
  {
    id: "workout",
    name: "Entrenamiento",
    description: "Rutina semanal con marcas de completado y una tabla de ejercicios.",
    document: createDocument({
      description: "Mi rutina semanal, con los días completados y el detalle de cada ejercicio.",
      blocks: [
        { id: "titulo", type: "heading", text: "Entrenamiento de la semana", level: 1 },
        {
          id: "intro",
          type: "text",
          text: "Marca los días que completes. La tabla guarda series, repeticiones y peso de cada ejercicio.",
        },
        {
          id: "dias",
          type: "checklist",
          title: "Días",
          items: [
            { id: "lunes", label: "Lunes", detail: "Pecho y tríceps" },
            { id: "martes", label: "Martes", detail: "Espalda y bíceps" },
            { id: "miercoles", label: "Miércoles", detail: "Descanso activo" },
            { id: "jueves", label: "Jueves", detail: "Piernas" },
            { id: "viernes", label: "Viernes", detail: "Hombros y core" },
          ],
        },
        {
          id: "ejercicios",
          type: "table",
          title: "Ejercicios",
          columns: ["Ejercicio", "Series", "Repeticiones", "Peso", "Notas"],
          rows: [],
        },
      ],
    }),
  },
  {
    id: "social",
    name: "Planificador social",
    description: "Borradores de publicaciones con red, fecha y estado.",
    document: createDocument({
      description: "Prepara publicaciones, guárdalas como borrador y sigue su estado.",
      blocks: [
        { id: "titulo", type: "heading", text: "Planificador de publicaciones", level: 1 },
        {
          id: "borrador",
          type: "form",
          title: "Nueva publicación",
          submitLabel: "Guardar borrador",
          fields: [
            { id: "contenido", label: "Contenido", kind: "textarea" },
            {
              id: "red",
              label: "Red",
              kind: "select",
              options: ["Instagram", "LinkedIn", "X", "TikTok"],
            },
            { id: "fecha", label: "Fecha", kind: "date" },
          ],
        },
        {
          id: "calendario",
          type: "calendar",
          title: "Fechas",
          events: [],
        },
        {
          id: "publicaciones",
          type: "table",
          title: "Publicaciones",
          columns: ["Contenido", "Red", "Estado", "Fecha"],
          rows: [],
        },
      ],
    }),
  },
  {
    id: "reading",
    name: "Lista de lectura",
    description: "Fuentes guardadas con estado de lectura.",
    document: createDocument({
      description: "Lo que quiero leer, con su estado.",
      blocks: [
        { id: "titulo", type: "heading", text: "Lista de lectura", level: 1 },
        {
          id: "fuentes",
          type: "list",
          title: "Pendientes",
          items: [],
        },
        {
          id: "resumen",
          type: "chart",
          title: "Por estado",
          series: [
            { label: "Pendiente", value: 0 },
            { label: "Leyendo", value: 0 },
            { label: "Leído", value: 0 },
          ],
        },
      ],
    }),
  },
  {
    id: "blank",
    name: "Panel en blanco",
    description: "Empieza con un título y añade lo que necesites.",
    document: createDocument({
      blocks: [
        { id: "titulo", type: "heading", text: "Nuevo panel", level: 1 },
        {
          id: "intro",
          type: "text",
          text: "Pide al agente que añada secciones, tablas o formularios a este panel.",
        },
      ],
    }),
  },
]

export function findTemplate(id: string): PanelTemplate | undefined {
  return panelTemplates.find((template) => template.id === id)
}
