import { t } from "@/common/i18n/index";
import { licenseURL, thirdPartyLicenseURL } from "@/common/links/github";
import { materialIconsGuideURL } from "@/common/links/google";
import { useMessageStore } from "@/renderer/store/message";

export function openCopyright() {
  useMessageStore().enqueue({
    text: "Copyright and License",
    attachments: [
      {
        type: "link",
        text: t.shogiHomeLab,
        url: licenseURL,
      },
      {
        type: "link",
        text: "Third Party Libraries",
        url: thirdPartyLicenseURL,
      },
      {
        type: "link",
        text: "Material Icons",
        url: materialIconsGuideURL,
      },
    ],
  });
}
