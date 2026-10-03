"use client";

import { useMemo, useState } from "react";

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import type { ModelOption } from "@/components/assistant/assistant-context";
import {
  ArrowDown01Icon,
  HugeiconsIcon,
  Tick01Icon,
} from "@/components/icons";
import { cn } from "@/lib/utils";

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  kimi: "Kimi",
  ollama: "Ollama",
  openai: "OpenAI",
};

function getProviderLogo(provider: string) {
  return provider === "kimi" ? "moonshotai" : provider;
}

function getProviderName(provider: string) {
  return PROVIDER_NAMES[provider]
    ?? provider.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

interface AssistantModelSelectorProps {
  model: string;
  modelOptions: ModelOption[];
  modelReady: boolean;
  onModelChange: (model: string) => void;
}

export function AssistantModelSelector({
  model,
  modelOptions,
  modelReady,
  onModelChange,
}: AssistantModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const selectedModel = modelOptions.find((option) => option.id === model);
  const groupedModels = useMemo(() => {
    const groups = new Map<string, ModelOption[]>();

    for (const option of modelOptions) {
      const existing = groups.get(option.provider);
      if (existing) existing.push(option);
      else groups.set(option.provider, [option]);
    }

    return Array.from(groups.entries());
  }, [modelOptions]);
  const disabled = !modelReady || modelOptions.length === 0;
  const selectedName = selectedModel?.name
    || model.split("/").pop()?.split("-")[0]
    || (modelReady ? "Select model" : "Loading models…");

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <button
          aria-label={`Select AI model. Current model: ${selectedName}`}
          className={cn(
            "inline-flex h-8 min-w-0 max-w-48 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-muted-foreground transition-colors duration-150 phone-touch:h-11",
            "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
          disabled={disabled}
          type="button"
        >
          {selectedModel ? (
            <ModelSelectorLogo
              className="size-3.5 shrink-0"
              provider={getProviderLogo(selectedModel.provider)}
            />
          ) : null}
          <ModelSelectorName className="min-w-0">{selectedName}</ModelSelectorName>
          <HugeiconsIcon
            aria-hidden="true"
            className="shrink-0 opacity-60"
            icon={ArrowDown01Icon}
            size={12}
          />
        </button>
      </ModelSelectorTrigger>

      <ModelSelectorContent
        className="w-[min(28rem,calc(100vw-2rem))] overflow-hidden sm:max-w-md"
        title="Select AI model"
      >
        <ModelSelectorInput placeholder="Search models…" />
        <ModelSelectorList className="max-h-[min(22rem,60dvh)]">
          <ModelSelectorEmpty>No matching models found.</ModelSelectorEmpty>
          {groupedModels.map(([provider, options]) => (
            <ModelSelectorGroup heading={getProviderName(provider)} key={provider}>
              {options.map((option) => {
                const selected = option.id === model;

                return (
                  <ModelSelectorItem
                    aria-label={`Use ${option.name}`}
                    key={`${option.provider}:${option.id}`}
                    onSelect={() => {
                      onModelChange(option.id);
                      setOpen(false);
                    }}
                    value={`${option.name} ${option.description ?? ""} ${option.provider} ${option.id}`}
                  >
                    <ModelSelectorLogo
                      className="size-4 shrink-0"
                      provider={getProviderLogo(option.provider)}
                    />
                    <div className="min-w-0 flex-1 py-0.5">
                      <ModelSelectorName className="block">{option.name}</ModelSelectorName>
                      {option.description ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </div>
                    <HugeiconsIcon
                      aria-hidden="true"
                      className={cn("ml-auto shrink-0", selected ? "opacity-100" : "opacity-0")}
                      icon={Tick01Icon}
                      size={14}
                    />
                  </ModelSelectorItem>
                );
              })}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
