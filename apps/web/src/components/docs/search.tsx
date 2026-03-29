"use client";

import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useDocsSearch } from "fumadocs-core/search/client";
import { create } from "@orama/orama";
import { HugeiconsIcon, Search01Icon } from "@/components/icons";

function initOrama() {
  return create({
    schema: { _: "string" },
    language: "english",
  });
}

export function DocsSearchDialog(props: SharedProps) {
  const { search, setSearch, query } = useDocsSearch({
    type: "static",
    initOrama,
  });

  return (
    <SearchDialog
      search={search}
      onSearchChange={setSearch}
      isLoading={query.isLoading}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <HugeiconsIcon icon={Search01Icon} size={20} className="size-5 text-fd-muted-foreground shrink-0" />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList
          items={query.data !== "empty" ? query.data : null}
        />
      </SearchDialogContent>
    </SearchDialog>
  );
}
