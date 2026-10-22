# NOTICE

`tools/realmouse-solver` is a separate program that talks to the XianyuSellerAgent API over HTTP only. It is **not** part of the Node.js monorepo build and is licensed differently from the rest of this repository.

## Third-party code

The physical-mouse slider engine under `common/services/captcha/` is taken from
[zhinianboke/xianyu-auto-reply](https://github.com/zhinianboke/xianyu-auto-reply), licensed under the
**GNU Affero General Public License v3.0** (see `LICENSE` in this directory):

| File | Origin |
| --- | --- |
| `real_mouse_slider.py` | `common/services/captcha/real_mouse_slider.py` (SQLAlchemy persistence removed) |
| `real_mouse_coordinates.py` | same path upstream |
| `weighted_scheduler.py` | same path upstream (database-backed weights replaced by in-memory weights) |
| `win_input.py` | same path upstream |
| `windows_foreground.py` | same path upstream |
| `slider_stealth.py` | reduced to the two sentinel constants the engine returns |
| `human_trails/*.json` | recorded human mouse trajectories shipped with the upstream project |

Changes made here: the engine is wrapped by `service.py` (FastAPI, this repository) and runs without the upstream database. Modified files keep the upstream license.

## Consequences

- Everything in this directory is distributed under AGPL-3.0. If you modify the engine and let others use it over a network, AGPL §13 obliges you to offer them the corresponding source.
- The rest of this repository (apps/, docker/, scripts/, …) does not link to or import this code; the only coupling is the HTTP protocol described in `README.md`, which any compatible solver may implement.
