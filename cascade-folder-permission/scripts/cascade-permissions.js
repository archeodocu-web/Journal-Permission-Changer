/**
 * cascade folder permission
 *
 * Based on Bruce A. Moser's MIT-licensed Cascade folder permission module.
 * Changes in this fork:
 * - Accept Foundry's alphanumeric User IDs (not only numeric IDs).
 * - Distinguish NOCHANGE (-10) from DEFAULT (-20).
 * - Support INHERIT (-1) as a stored ownership level.
 * - Interpret a per-user DEFAULT selection as removal of that user's explicit
 *   ownership override on the target folder and cascaded documents.
 * - Add an explicit reset option which removes all per-user overrides and sets
 *   ownership.default to INHERIT (-1) on every contained document.
 * - Improve error handling and report reset results separately.
 *
 * Intended for Foundry VTT v14.
 */
const MODULE_ID = "cascade-folder-permission";
const LOG = (...args) => console.log(`${MODULE_ID} |`, ...args);

const OWNERSHIP_LEVELS = new Set([-1, 0, 1, 2, 3]);
const getMetaLevel = (key, fallback) =>
  Number(globalThis.CONST?.DOCUMENT_META_OWNERSHIP_LEVELS?.[key] ?? fallback);
const getInheritLevel = () =>
  Number(globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.INHERIT ?? -1);

Hooks.once("init", () => {
  LOG("Initializing cascade folder permission folder permission");
});

Hooks.on("renderDocumentOwnershipConfig", (app, html, context) => {
  const doc = app.document ?? app.object;
  const isFolder = context?.isFolder ?? (doc instanceof Folder);
  if (!isFolder || !(doc instanceof Folder)) return;

  LOG("Injecting cascade controls for folder:", doc.name);
  const loc = (key) => game.i18n.localize(`CASCADE_PERMS_V14.${key}`);
  const isJQuery = typeof jQuery !== "undefined" && html instanceof jQuery;
  const formEl = isJQuery ? html[0] : html;
  const form = formEl.querySelector?.("form") ?? formEl.closest?.("form") ?? formEl;
  if (!form) {
    LOG("Could not locate ownership form for folder:", doc.name);
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.classList.add("cascade-folder-permission");
  wrapper.innerHTML = `
    <label class="cascade-checkbox">
      <input type="checkbox" name="cascade-to-subfolders" />
      <span>${loc("CascadeHint")}</span>
    </label>
    <p class="cascade-note">${loc("CascadeNote")}</p>
    <label class="cascade-checkbox cascade-reset-checkbox">
      <input type="checkbox" name="reset-to-parent-inherit" />
      <span>${loc("ResetHint")}</span>
    </label>
    <p class="cascade-note cascade-reset-note">${loc("ResetNote")}</p>
  `;

  const footer =
    form.querySelector("footer") ??
    form.querySelector(".sheet-footer") ??
    form.querySelector('button[type="submit"]')?.parentElement;
  if (footer) footer.insertAdjacentElement("beforebegin", wrapper);
  else form.appendChild(wrapper);

  if (typeof app.setPosition === "function") app.setPosition({ height: "auto" });

  const actualForm = formEl.tagName === "FORM" ? formEl : formEl.querySelector("form") ?? formEl;
  if (!actualForm || actualForm.dataset.cascadeListenerAttached) return;
  actualForm.dataset.cascadeListenerAttached = "true";

  LOG("Attaching submit listener to form for folder:", doc.name);
  actualForm.addEventListener(
    "submit",
    async (event) => {
      const shouldCascade = Boolean(
        actualForm.querySelector('input[name="cascade-to-subfolders"]')?.checked
      );
      const shouldReset = Boolean(
        actualForm.querySelector('input[name="reset-to-parent-inherit"]')?.checked
      );
      const shouldRun = shouldCascade || shouldReset;

      LOG("Form submitted", {
        folder: doc.name,
        cascade: shouldCascade,
        resetToParentInherit: shouldReset,
      });
      if (!shouldRun) return;

      // Foundry v13/v14 uses ApplicationV2. Intercept synchronously so the
      // original handler cannot pass UI meta-levels (-10/-20) into the model.
      if (!isJQuery) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }

      const formData = _readFormData(actualForm);
      LOG("Ownership form data:", JSON.stringify(formData));

      try {
        // In V1, Foundry's native submit handler must finish first. In V2 we
        // intercepted it, so save the selected folder's own concrete changes.
        if (isJQuery) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        } else {
          const folderUpdate = _buildOwnershipUpdate(formData, doc);
          if (Object.keys(folderUpdate).length) {
            await doc.update(folderUpdate);
            LOG("Saved folder ownership changes:", JSON.stringify(folderUpdate));
          }
        }

        if (shouldReset) {
          await _resetDocumentsToParentInheritance(doc);
        } else {
          await _cascadeOwnership(doc, formData);
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Cascade operation failed:`, err);
        ui.notifications.error(
          game.i18n.localize("CASCADE_PERMS_V14.ErrorCascade") ||
            "Cascade folder permission: operation failed. Check the console (F12)."
        );
      } finally {
        if (!isJQuery && typeof app.close === "function") await app.close();
      }
    },
    { capture: !isJQuery }
  );
});

/** Read form values using Foundry's FormDataExtended when available. */
function _readFormData(form) {
  const FDE =
    foundry?.applications?.ux?.FormDataExtended ??
    globalThis.FormDataExtended;
  if (FDE) {
    try {
      return new FDE(form).object ?? {};
    } catch (err) {
      LOG("FormDataExtended failed; reading select fields manually:", err);
    }
  }

  const result = {};
  for (const select of form.querySelectorAll("select")) {
    if (select.name) result[select.name] = select.value;
  }
  return result;
}

/**
 * Normalize a form field key to "default" or a real User ID.
 * Foundry User IDs are alphanumeric strings (typically 16 characters).
 */
function _normalizeOwnershipKey(rawKey) {
  let key = String(rawKey);
  key = key.replace(/^ownership\./, "");
  if (key.startsWith("ownership[")) key = key.slice("ownership[".length).replace(/\]$/, "");
  if (key === "default") return key;

  // Validate against the current world's actual Users collection. This avoids
  // accidentally accepting unrelated form keys while supporting IDs like the
  // ones shown in the user's Foundry log (e.g. D40G9b2nJdKw97qQ).
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return null;
  return game.users?.get?.(key) ? key : null;
}

/**
 * Parse the ownership controls into a safe update description.
 *
 * -1: stored INHERIT level.
 * -10: UI meta-level NOCHANGE; preserve the existing value.
 * -20: UI meta-level DEFAULT; for a player row, remove that explicit player
 *      override so the document's default applies; for the default row, use
 *      INHERIT from the containing folder.
 */
function _extractOwnershipChanges(formData, folder) {
  const noChange = getMetaLevel("NOCHANGE", -10);
  const useDefault = getMetaLevel("DEFAULT", -20);
  const inherit = getInheritLevel();
  const source =
    formData && typeof formData === "object"
      ? (formData.ownership ?? formData)
      : {};

  const ownership = {};
  const removeUserIds = new Set();
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = _normalizeOwnershipKey(rawKey);
    if (!key) continue;

    const value = Number(rawValue);
    if (value === noChange) continue;

    if (value === useDefault) {
      if (key === "default") ownership.default = inherit;
      else removeUserIds.add(key);
      continue;
    }

    if (!OWNERSHIP_LEVELS.has(value)) {
      LOG(`Skipping unsupported permission value for "${key}":`, rawValue);
      continue;
    }
    ownership[key] = value;
  }

  // When applying individual player levels without an explicit default value,
  // keep the selected folder's default as the document default. INHERIT (-1)
  // is valid and must not be replaced with NONE.
  const hasPlayerLevel = Object.keys(ownership).some((key) => key !== "default");
  if (!Object.hasOwn(ownership, "default") && hasPlayerLevel) {
    const folderDefault = Number(folder?.ownership?.default);
    ownership.default = OWNERSHIP_LEVELS.has(folderDefault)
      ? folderDefault
      : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
  }

  return { ownership, removeUserIds: [...removeUserIds] };
}


/** Create Foundry v14's typed deletion operator for a nested ownership key. */
function _newForcedDeletion() {
  const ForcedDeletion = foundry?.data?.operators?.ForcedDeletion;
  if (typeof ForcedDeletion !== "function") {
    throw new Error("Foundry v14 ForcedDeletion operator is unavailable.");
  }
  return new ForcedDeletion();
}

/** Build a Foundry update payload, including deletion operations. */
function _buildOwnershipUpdate(formData, folder) {
  const changes = _extractOwnershipChanges(formData, folder);
  const update = {};
  if (Object.keys(changes.ownership).length) {
    update.ownership = { ...changes.ownership };
  }
  for (const userId of changes.removeUserIds) {
    update[`ownership.${userId}`] = _newForcedDeletion();
  }
  return update;
}

/** Build a per-document update object for a cascade operation. */
function _buildDocumentUpdate(document, ownership, removeUserIds) {
  const update = { _id: document.id };
  if (Object.keys(ownership).length) update.ownership = { ...ownership };
  for (const userId of removeUserIds) {
    update[`ownership.${userId}`] = _newForcedDeletion();
  }
  return update;
}

/**
 * Apply the selected ownership changes recursively to all documents.
 * NOCHANGE entries remain untouched; DEFAULT player entries remove overrides.
 */
async function _cascadeOwnership(folder, formData) {
  const { ownership, removeUserIds } = _extractOwnershipChanges(formData, folder);
  if (!Object.keys(ownership).length && removeUserIds.length === 0) {
    LOG("No ownership changes selected (all player/default values are No Change).");
    ui.notifications.info(
      game.i18n.localize("CASCADE_PERMS_V14.NoChanges") ||
        "No permission changes were selected. Use the reset option to clear all overrides."
    );
    return;
  }

  const allFolders = _collectFolderTree(folder);
  const docClass = folder.documentClass;
  const allUpdates = [];
  for (const currentFolder of allFolders) {
    const docs = currentFolder.contents ?? [];
    LOG(`Folder "${currentFolder.name}": ${docs.length} document(s)`);
    for (const document of docs) {
      allUpdates.push(_buildDocumentUpdate(document, ownership, removeUserIds));
    }
  }

  LOG(`Applying ownership changes to ${allUpdates.length} document(s)`);
  await _applyBatchWithFallback(docClass, allUpdates, allFolders.length - 1);
}

/**
 * Reset every contained document so all users inherit permissions from its
 * immediate parent folder. All explicit per-user keys are removed and the
 * document default is set to Foundry's INHERIT (-1) level.
 */
async function _resetDocumentsToParentInheritance(folder) {
  const allFolders = _collectFolderTree(folder);
  const docClass = folder.documentClass;
  const inherit = getInheritLevel();
  const allUpdates = [];

  for (const currentFolder of allFolders) {
    const docs = currentFolder.contents ?? [];
    LOG(`Reset folder "${currentFolder.name}": ${docs.length} document(s)`);
    for (const document of docs) {
      const update = {
        _id: document.id,
        ownership: { default: inherit },
      };

      // Remove every current explicit player override, including entries for
      // users that may since have been removed from the world.
      for (const userId of Object.keys(document.ownership ?? {})) {
        if (userId === "default") continue;
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) continue;
        update[`ownership.${userId}`] = _newForcedDeletion();
      }
      allUpdates.push(update);
    }
  }

  LOG(`Resetting ${allUpdates.length} document(s) to parent-folder inheritance`);
  await _applyBatchWithFallback(docClass, allUpdates, allFolders.length - 1, true);
}

/** Collect the selected folder and every descendant exactly once. */
function _collectFolderTree(folder) {
  try {
    return [folder, ...folder.getSubfolders(true)];
  } catch (err) {
    LOG("getSubfolders failed; using manual traversal:", err);
    return [folder, ..._getSubfoldersManual(folder)];
  }
}

/** Apply one batch; retry individually if one document causes the batch to fail. */
async function _applyBatchWithFallback(docClass, updates, subfolderCount, isReset = false) {
  if (!updates.length) {
    ui.notifications.info(
      game.i18n.localize("CASCADE_PERMS_V14.NoDocuments") ||
        "No documents found in this folder tree."
    );
    return;
  }

  try {
    await docClass.updateDocuments(updates);
    LOG(`Successfully updated ${updates.length} document(s)`);
    const key = isReset ? "SuccessReset" : "SuccessCascade";
    ui.notifications.info(
      game.i18n.format(`CASCADE_PERMS_V14.${key}`, {
        count: updates.length,
        folders: subfolderCount,
      })
    );
  } catch (batchErr) {
    console.error(`${MODULE_ID} | Batch update failed; retrying individually:`, batchErr);
    let ok = 0;
    let failed = 0;
    for (const update of updates) {
      try {
        await docClass.updateDocuments([update]);
        ok++;
      } catch (singleErr) {
        failed++;
        console.error(`${MODULE_ID} | Failed document update:`, update, singleErr);
      }
    }

    if (ok > 0) {
      const key = isReset ? "SuccessReset" : "SuccessCascade";
      ui.notifications.info(
        game.i18n.format(`CASCADE_PERMS_V14.${key}`, {
          count: ok,
          folders: subfolderCount,
        })
      );
    }
    if (failed > 0) {
      ui.notifications.warn(
        game.i18n.format("CASCADE_PERMS_V14.PartialError", { failed })
      );
    }
  }
}

/** Manual fallback if Folder#getSubfolders is unavailable. */
function _getSubfoldersManual(root) {
  const result = [];
  const stack = [...(root.children ?? []).map((child) => child.folder ?? child)];
  const seen = new Set();
  while (stack.length) {
    const folder = stack.pop();
    if (!(folder instanceof Folder) || seen.has(folder.id)) continue;
    seen.add(folder.id);
    result.push(folder);
    for (const child of folder.children ?? []) {
      stack.push(child.folder ?? child);
    }
  }
  return result;
}
