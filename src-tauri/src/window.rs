//! The main window's position and size: recorded, and restored at start when it
//! fits a display; otherwise the default size, centred (docs/adr/0004).

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// The smallest window worth restoring; anything smaller is treated as broken.
const MIN_W: u32 = 400;
const MIN_H: u32 = 300;

/// Whether `r` lies inside one of `displays` (all in physical pixels).
pub fn fits(r: &Rect, displays: &[Rect]) -> bool {
    r.w >= MIN_W
        && r.h >= MIN_H
        && displays.iter().any(|d| {
            r.x >= d.x
                && r.y >= d.y
                && r.x as i64 + r.w as i64 <= d.x as i64 + d.w as i64
                && r.y as i64 + r.h as i64 <= d.y as i64 + d.h as i64
        })
}

/// What to do at start: restore the saved rectangle, or use the default.
pub fn restore_to(saved: Option<Rect>, displays: &[Rect]) -> Option<Rect> {
    saved.filter(|r| fits(r, displays))
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: Rect = Rect {
        x: 0,
        y: 0,
        w: 3840,
        h: 2160,
    };
    const RIGHT: Rect = Rect {
        x: 3840,
        y: 0,
        w: 2560,
        h: 1440,
    };

    #[test]
    fn a_rectangle_inside_a_display_is_restored() {
        let r = Rect {
            x: 200,
            y: 160,
            w: 2400,
            h: 1600,
        };
        assert_eq!(restore_to(Some(r), &[D]), Some(r));
    }

    #[test]
    fn a_rectangle_sticking_out_uses_the_default() {
        assert_eq!(
            restore_to(
                Some(Rect {
                    x: 3000,
                    y: 100,
                    w: 1500,
                    h: 950
                }),
                &[D]
            ),
            None
        );
        assert_eq!(
            restore_to(
                Some(Rect {
                    x: -10,
                    y: 0,
                    w: 1500,
                    h: 950
                }),
                &[D]
            ),
            None
        );
    }

    #[test]
    fn a_rectangle_on_a_display_that_was_removed_uses_the_default() {
        let r = Rect {
            x: 4000,
            y: 100,
            w: 1500,
            h: 950,
        };
        assert_eq!(restore_to(Some(r), &[D, RIGHT]), Some(r));
        assert_eq!(restore_to(Some(r), &[D]), None);
    }

    #[test]
    fn a_rectangle_spanning_two_displays_is_not_inside_one() {
        assert_eq!(
            restore_to(
                Some(Rect {
                    x: 3000,
                    y: 0,
                    w: 1500,
                    h: 950
                }),
                &[D, RIGHT]
            ),
            None
        );
    }

    #[test]
    fn a_tiny_rectangle_uses_the_default() {
        assert_eq!(
            restore_to(
                Some(Rect {
                    x: 10,
                    y: 10,
                    w: 100,
                    h: 50
                }),
                &[D]
            ),
            None
        );
    }

    #[test]
    fn nothing_saved_uses_the_default() {
        assert_eq!(restore_to(None, &[D]), None);
    }

    #[test]
    fn the_record_reads_back() {
        let r = Rect {
            x: 1,
            y: 2,
            w: 1500,
            h: 950,
        };
        let s = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<Rect>(&s).unwrap(), r);
    }
}
