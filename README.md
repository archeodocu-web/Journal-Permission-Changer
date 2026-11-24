# cascade folder permission

A local Foundry VTT v14 fork of [Bruce A. Moser's Cascade folder permission](https://github.com/bruceamoser/foundry-apply-permissions).

## Fixes

- Supports Foundry's alphanumeric User IDs.
- Supports the stored `INHERIT` ownership level (`-1`).
- Correctly distinguishes the UI-only `NOCHANGE` (`-10`) and `DEFAULT` (`-20`) values.
- A player row set to `Default` removes that player's explicit override using Foundry v14's `ForcedDeletion` data operator.
- Adds a separate **Reset all contained documents to inherit permissions from their parent folders** option. This removes all explicit player overrides on each contained document and sets `ownership.default` to `-1`.
- The explicit reset affects documents inside the selected folder and all descendant folders. It does not reset the selected folder itself; that folder remains the source of inherited permissions.

## Install

1. Make a backup of your Foundry `Data/modules` folder or at least the existing `cascade-folder-permission` module.
2. Extract the `cascade-folder-permission` folder into `Data/modules/`.
3. In Foundry, disable the original **Cascade folder permission** module to avoid duplicate checkboxes.
4. Enable **cascade folder permission** and reload the world.
5. Right-click a Journal folder, choose **Configure Ownership**, and use the new reset checkbox.

## Important

The reset option is destructive for explicit permissions on contained documents. It resets them to inherit from their immediate parent folder. Confirm that the selected folder and its parent-folder permission settings are correct before using it.

## License

MIT. Upstream copyright and license notice retained.
