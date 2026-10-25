import { memo } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useRunSteps } from "@/features/workflows/components/run-context"
import {
  nodeRegistry,
  type StepNodeType,
} from "@/features/workflows/nodes/node-registry"

const handleClass =
  "h-3.5! w-1.5! min-w-0! border-0! bg-border!"

function StepNodeComponent({ id, data, selected }: NodeProps<StepNodeType>) {
  const { type, kind, title, values } = data
  const def = nodeRegistry[type]
  const Icon = def.icon
  const fields = def.fields.filter((field) => values[field.key])

  const { steps, live } = useRunSteps()
  const status = steps.find((step) => step.nodeId === id)?.status
  const isRunning = status === "running" && live
  const isFailed = status === "failed"
  const isDone = status === "done" || status === "skipped"

  // A trigger starts the flow and takes no input.
  const hasTarget = kind !== "trigger"
  const isCondition = type === "condition"

  return (
    <div
      className={cn(
        "min-w-50 max-w-80 rounded-(--radius) border-2 border-border bg-card text-card-foreground",
        isRunning && "border-blue-500",
        isFailed && "border-destructive",
        isDone && !isFailed && "border-emerald-500/50",
        selected && "ring-2 ring-ring ring-offset-2 ring-offset-background"
      )}
    >
      {hasTarget && (
        <Handle
          type="target"
          position={Position.Left}
          style={{ transform: "translate(-100%, -50%)" }}
          className={cn(handleClass, "rounded-l-xs! rounded-r-none!")}
        />
      )}

      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <div
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md",
            def.accent
          )}
        >
          {isRunning ? <Spinner className="size-4" /> : <Icon className="size-4" />}
        </div>
        <span className="text-sm font-semibold">{title}</span>
        {status === "failed" && (
          <span className="ml-auto text-[10px] font-medium text-destructive">falló</span>
        )}
      </div>

      {fields.length > 0 && (
        <>
          <div className="border-t border-border" />
          <div className="flex flex-col gap-1.5 px-3 py-2.5">
            {fields.slice(0, 3).map((field) => (
              <div
                key={field.key}
                className="flex items-center justify-between gap-4 text-xs"
              >
                <span className="shrink-0 text-muted-foreground">{field.label}</span>
                <span className="truncate font-medium">{values[field.key]}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {isCondition ? (
        <>
          {/* Two exits, labelled: the engine follows exactly one of them. */}
          <Handle
            id="true"
            type="source"
            position={Position.Right}
            style={{ top: "38%", transform: "translate(100%, -50%)" }}
            className={cn(handleClass, "rounded-l-none! rounded-r-xs! bg-emerald-500!")}
          />
          <Handle
            id="false"
            type="source"
            position={Position.Right}
            style={{ top: "72%", transform: "translate(100%, -50%)" }}
            className={cn(handleClass, "rounded-l-none! rounded-r-xs! bg-rose-500!")}
          />
          <div className="pointer-events-none absolute right-2 top-[30%] text-[9px] font-semibold text-emerald-600">
            sí
          </div>
          <div className="pointer-events-none absolute right-2 top-[64%] text-[9px] font-semibold text-rose-600">
            no
          </div>
        </>
      ) : (
        <Handle
          type="source"
          position={Position.Right}
          style={{ transform: "translate(100%, -50%)" }}
          className={cn(handleClass, "rounded-l-none! rounded-r-xs!")}
        />
      )}
    </div>
  )
}

export const StepNode = memo(StepNodeComponent)
