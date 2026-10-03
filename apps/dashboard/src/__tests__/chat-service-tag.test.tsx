import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MediaCodeTag } from "@/components/ai-elements/media-code-tag";
const mocks = vi.hoisted(() => ({ open: vi.fn(), container: { id: "559a5c6ca5b2abcd", name: "559a5c6ca5b2", image: "public.ecr.aws/supabase/logflare:1.45.6", labels: {} } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-containers", () => ({ useContainerLookup: () => ({ containers: [mocks.container] }) }));
vi.mock("@/components/media/media-detail-context", () => ({ useMediaDetail: () => ({ openDetail: vi.fn(), findItem: () => null }), useMediaLibraryDemand: vi.fn() }));
vi.mock("@/components/quick-look/quick-look-context", () => ({ useQuickLook: () => ({ open: mocks.open }) }));
beforeEach(() => mocks.open.mockClear());
it("names a service tag and opens it once without triggering its surrounding link", () => {
  const parentClick = vi.fn();
  render(<a href="/dashboard/containers?q=559a5c6ca5b2" onClick={parentClick}><MediaCodeTag toolIntent="containers">559a5c6ca5b2</MediaCodeTag></a>);
  fireEvent.click(screen.getByRole("button", { name: "logflare" }));
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith(mocks.container);
  expect(parentClick).not.toHaveBeenCalled();
});

it("opens a full registry image reference as the matching service", () => {
  render(<MediaCodeTag>{mocks.container.image}</MediaCodeTag>);
  fireEvent.click(screen.getByRole("button", { name: mocks.container.image }));
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith(mocks.container);
});
it("does not turn an unknown Docker image into a media lookup", () => {
  render(<MediaCodeTag>public.ecr.aws/supabase/other:1.45.6</MediaCodeTag>);
  expect(screen.queryByRole("button")).toBeNull();
});
