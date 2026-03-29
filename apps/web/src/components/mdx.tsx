import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { TalomeMermaid as Mermaid } from "@/components/docs/themed-mermaid";
import { VideoPlaceholder } from "@/components/docs/video-placeholder";
import { ScreenshotPlaceholder } from "@/components/docs/screenshot-placeholder";
import {
  ChatSimulation,
  UserMessage,
  AssistantMessage,
  ToolCall,
} from "@/components/docs/chat-simulation";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    Tab,
    Tabs,
    Step,
    Steps,
    Mermaid,
    VideoPlaceholder,
    ScreenshotPlaceholder,
    ChatSimulation,
    UserMessage,
    AssistantMessage,
    ToolCall,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
