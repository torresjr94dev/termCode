//! Minimal RFC 3339 → epoch-ms parser (enough for the timestamps Claude Code and
//! Codex write: `2026-10-19T18:40:00.108298+00:00`, `2026-01-23T20:51:21.210Z`).

pub fn parse_rfc3339_ms(input: &str) -> Option<i64> {
    let b = input.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> { input.get(range)?.parse().ok() };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }

    let mut rest = &input[19..];
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let ms_digits: String = frac[..digits]
            .chars()
            .chain("000".chars())
            .take(3)
            .collect();
        millis = ms_digits.parse().ok()?;
        rest = &frac[digits..];
    }

    let offset_minutes = match rest {
        "Z" | "z" => 0,
        tz if tz.len() == 6 && matches!(&tz[..1], "+" | "-") && &tz[3..4] == ":" => {
            let sign = if tz.starts_with('-') { -1 } else { 1 };
            sign * (tz[1..3].parse::<i64>().ok()? * 60 + tz[4..6].parse::<i64>().ok()?)
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + millis)
}

/// Howard Hinnant's algorithm: days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_instants() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_ms("2026-01-23T20:51:21.210Z"),
            Some(1_769_201_481_210)
        );
        assert_eq!(
            parse_rfc3339_ms("2026-10-19T18:40:00.108298+00:00"),
            Some(1_792_435_200_108)
        );
        assert_eq!(
            parse_rfc3339_ms("2026-10-19T12:40:00-06:00"),
            parse_rfc3339_ms("2026-10-19T18:40:00Z")
        );
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_rfc3339_ms("ayer"), None);
        assert_eq!(parse_rfc3339_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_rfc3339_ms("2026-01-01T00:00:00"), None);
    }
}
