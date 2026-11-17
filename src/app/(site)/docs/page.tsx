import type { Metadata } from "next";
import { DocsShell } from "@/components/docs-shell";
import { allMeta } from "@/lib/api/registry";
import { DOCS_DESCRIPTION, DOCS_TITLE, jsonLdText, pageMeta } from "@/lib/seo";
import { SITE_NAME, SITE_PITCH, SITE_URL } from "@/lib/site";

export const metadata: Metadata = pageMeta({ title: DOCS_TITLE, absolute: true, description: DOCS_DESCRIPTION, path: "/docs" });

export default function DocsPage() {
  const list = allMeta();
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: `Dokumentasi ${SITE_NAME}`,
        description: DOCS_DESCRIPTION,
        url: `${SITE_URL}/docs`,
        isPartOf: { "@id": `${SITE_URL}/#website` },
        publisher: { "@id": `${SITE_URL}/#org` },
        inLanguage: "id-ID",
        about: `REST API ${SITE_PITCH}`,
      },
      {
        "@type": "ItemList",
        name: `Daftar endpoint ${SITE_NAME}`,
        numberOfItems: list.length,
        itemListElement: list.map((e, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: e.title,
          url: `${SITE_URL}/docs/${e.category}#${e.category}-${e.slug}`,
        })),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Dokumentasi", item: `${SITE_URL}/docs` },
        ],
      },
    ],
  };
  return (
    <>
      <DocsShell />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(jsonLd) }} />
    </>
  );
}
