const cheerio = require('cheerio');

const KOREAN_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const SHORT_SIDO_NAMES = new Set([
    '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
    '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'
]);

function cleanText(value) {
    return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function formatTime(hour, minute, second) {
    if (hour === undefined || hour === null || hour === '') {
        return null;
    }

    const hh = pad2(Number(hour));
    const mm = pad2(minute === undefined || minute === null || minute === '' ? 0 : Number(minute));

    if (second !== undefined && second !== null && second !== '') {
        return `${hh}:${mm}:${pad2(Number(second))}`;
    }

    return `${hh}:${mm}`;
}

function makeDateParts(year, month, day, hour, minute, second) {
    const numericYear = Number(year);
    const numericMonth = Number(month);
    const numericDay = Number(day);

    const date = new Date(numericYear, numericMonth - 1, numericDay);
    if (
        Number.isNaN(date.getTime()) ||
        date.getFullYear() !== numericYear ||
        date.getMonth() + 1 !== numericMonth ||
        date.getDate() !== numericDay
    ) {
        return null;
    }

    return {
        startyear: String(numericYear),
        startmonth: pad2(numericMonth),
        startday: pad2(numericDay),
        starttime: formatTime(hour, minute, second),
        startdayofweek: KOREAN_WEEKDAYS[date.getDay()]
    };
}

function makeEmptyDateParts() {
    return {
        startyear: null,
        startmonth: null,
        startday: null,
        starttime: null,
        startdayofweek: null
    };
}

function parseDateTime(text) {
    const original = cleanText(text);
    const now = new Date();

    if (!original) {
        console.error('[parser] 날짜 파싱 실패: 값이 비어 있습니다.');
        return makeEmptyDateParts();
    }

    // 예: 2026/05/26 11:13:12, 2026-05-26 11:13, 2026.05.26 11:13
    const numericFull = original.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (numericFull) {
        const parsed = makeDateParts(
            numericFull[1],
            numericFull[2],
            numericFull[3],
            numericFull[4],
            numericFull[5],
            numericFull[6]
        );
        if (parsed) return parsed;
    }

    // 예: 2026년 5월 26일 11시 13분
    const koreanFull = original.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분?)?(?:\s*(\d{1,2})\s*초?)?)?/);
    if (koreanFull) {
        const parsed = makeDateParts(
            koreanFull[1],
            koreanFull[2],
            koreanFull[3],
            koreanFull[4],
            koreanFull[5],
            koreanFull[6]
        );
        if (parsed) return parsed;
    }

    // 예: 05.26 11:13 또는 05/26 11:13. 연도는 현재 연도를 사용한다.
    const numericWithoutYear = original.match(/(\d{1,2})[./-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (numericWithoutYear) {
        const parsed = makeDateParts(
            now.getFullYear(),
            numericWithoutYear[1],
            numericWithoutYear[2],
            numericWithoutYear[3],
            numericWithoutYear[4],
            numericWithoutYear[5]
        );
        if (parsed) return parsed;
    }

    // 예: 오늘 10:57경, 금일 12:29, 오늘 11시 13분
    // 숫자 뒤에 ':' 또는 '시'가 오는 시간 표현을 잡는다.
    const todayTime = original.match(/(?:오늘|금일)\s*(?:오전|오후)?\s*(\d{1,2})(?:\s*[:시]\s*)(\d{1,2})?(?::(\d{1,2}))?/);
    if (todayTime) {
        const parsed = makeDateParts(
            now.getFullYear(),
            now.getMonth() + 1,
            now.getDate(),
            todayTime[1],
            todayTime[2],
            todayTime[3]
        );
        if (parsed) return parsed;
    }

    console.error('[parser] 날짜 파싱 실패:', original);
    return makeEmptyDateParts();
}

function isSidoToken(token) {
    if (!token) return false;
    if (SHORT_SIDO_NAMES.has(token)) return true;
    return /(특별자치도|특별자치시|특별시|광역시|자치도|도)$/.test(token);
}

function isGunguToken(token) {
    if (!token) return false;
    return /(시|군|구)$/.test(token) && !isSidoToken(token);
}

function isTownToken(token) {
    return /(읍|면)$/.test(token);
}

function isDongToken(token) {
    return /(동|리|가)$/.test(token);
}

function isRoadToken(token) {
    return /(로|길)$/.test(token);
}

function isBunjiToken(token) {
    return token === '산' || /^산?\d/.test(token) || /\d+-\d+/.test(token);
}

function parseAddress(address) {
    const original = cleanText(address);
    const result = {
        locsi: null,
        locgungu: null,
        locmenu: null,
        locdong: null,
        locbunji: null
    };

    if (!original) {
        console.error('[parser] 주소 파싱 실패: 값이 비어 있습니다.');
        return result;
    }

    try {
        const bracketRegion = original.match(/\[([^\]]+)\]/)?.[1];
        const cleanAddress = original
            .replace(/\[[^\]]+\]/g, ' ')
            .replace(/[(),]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const tokens = cleanAddress.split(' ').filter(Boolean);
        const remaining = [];

        for (let index = 0; index < tokens.length; index += 1) {
            const token = tokens[index];

            if (!result.locsi && index === 0 && isSidoToken(token)) {
                result.locsi = token;
                continue;
            }

            if (!result.locgungu && isGunguToken(token)) {
                result.locgungu = token;
                continue;
            }

            if (!result.locmenu && (isTownToken(token) || isRoadToken(token))) {
                result.locmenu = token;
                continue;
            }

            if (!result.locdong && isDongToken(token)) {
                result.locdong = token;
                continue;
            }

            if (isBunjiToken(token)) {
                result.locbunji = tokens.slice(index).join(' ');
                break;
            }

            remaining.push(token);
        }

        if (!result.locgungu && bracketRegion && isGunguToken(bracketRegion)) {
            result.locgungu = bracketRegion;
        }

        if (!result.locbunji && remaining.length > 0) {
            result.locbunji = remaining.join(' ');
        }
    } catch (error) {
        console.error('[parser] 주소 파싱 실패:', error.message, original);
    }

    return result;
}

function headerIndex(headers, tester) {
    return headers.findIndex((header) => tester(cleanText(header)));
}

function findDateLikeText(cells) {
    return cells.find((cell) =>
        /\d{4}[./-]\d{1,2}[./-]\d{1,2}/.test(cell) ||
        /\d{1,2}[./-]\d{1,2}\s+\d{1,2}:\d{1,2}/.test(cell) ||
        /(오늘|금일).*\d{1,2}[:시]\s*\d{0,2}/.test(cell) ||
        /\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/.test(cell)
    );
}

function findStatusLikeText(cells) {
    return cells.find((cell) => /(진행|진화|완료|발생|접수|종료|잔불|상태)/.test(cell));
}

function findAddressLikeText(cells, occurredAt, status) {
    return cells.find((cell) => {
        if (!cell || cell === occurredAt || cell === status) return false;
        return /(특별시|광역시|특별자치시|특별자치도|도|시|군|구|읍|면|동|리|로|길)/.test(cell);
    });
}

function tableHeaders($, table) {
    let headerCells = table.find('thead tr').first().find('th,td');
    if (headerCells.length === 0) {
        headerCells = table.find('tr').first().find('th');
    }

    return headerCells
        .map((_, cell) => cleanText($(cell).text()))
        .get();
}

function findTargetTable($) {
    const captionTable = $('table').filter((_, table) => {
        const caption = cleanText($(table).find('caption').text());
        return caption.includes('금일 산불') || caption.includes('산불 발생 현황');
    }).first();

    if (captionTable.length > 0) {
        return captionTable;
    }

    let titleNode = null;
    $('h1,h2,h3,h4,h5,h6,.tbl-title').each((_, element) => {
        const text = cleanText($(element).text());
        if (!titleNode && text.includes('금일 산불 현황')) {
            titleNode = $(element);
        }
    });

    if (titleNode) {
        const siblingTable = titleNode.nextAll('table').first();
        if (siblingTable.length > 0) {
            return siblingTable;
        }

        const nestedTable = titleNode.nextAll().find('table').first();
        if (nestedTable.length > 0) {
            return nestedTable;
        }
    }

    return $('table').filter((_, table) => {
        const headers = tableHeaders($, $(table)).join(' ');
        return headers.includes('발생일시') && headers.includes('주소') && headers.includes('진행상태');
    }).first();
}

function rowCells($, row) {
    return $(row)
        .find('th,td')
        .map((_, cell) => cleanText($(cell).text()))
        .get()
        .filter(Boolean);
}

function parseWildfireRows(html) {
    if (!html || typeof html !== 'string') {
        throw new Error('HTML 문자열이 비어 있습니다.');
    }

    const $ = cheerio.load(html);
    const table = findTargetTable($);

    if (!table || table.length === 0) {
        throw new Error('금일 산불 현황 테이블을 찾지 못했습니다. HTML 구조 변경 또는 JavaScript 렌더링 가능성이 있습니다.');
    }

    const tableText = cleanText(table.text());
    const hasNoDataMessage = /조회된\s*데이터가\s*없습니다/.test(tableText);

    const headers = tableHeaders($, table);
    const occurredAtIndex = headerIndex(headers, (header) => header.includes('발생일시') || (header.includes('발생') && header.includes('일시')));
    const addressIndex = headerIndex(headers, (header) => header.includes('주소'));
    const statusIndex = headerIndex(headers, (header) => header.includes('진행상태') || header.includes('상태'));
    const rows = [];
    const tableRows = table.find('tbody tr').length > 0 ? table.find('tbody tr') : table.find('tr').slice(1);

    tableRows.each((_, row) => {
        const cells = rowCells($, row);
        if (cells.length === 0) {
            return;
        }

        const joined = cells.join(' ');
        if (/조회된\s*데이터가\s*없습니다/.test(joined)) {
            return;
        }

        const occurredAt = cells[occurredAtIndex >= 0 ? occurredAtIndex : 0] || findDateLikeText(cells) || '';
        const status = cells[statusIndex >= 0 ? statusIndex : 2] || findStatusLikeText(cells) || '';
        const address = cells[addressIndex >= 0 ? addressIndex : 1] || findAddressLikeText(cells, occurredAt, status) || '';

        if (!occurredAt && !address) {
            return;
        }

        rows.push({
            occurredAt,
            address,
            status,
            raw: joined
        });
    });

    if (rows.length === 0 && hasNoDataMessage) {
        return [];
    }

    if (rows.length === 0) {
        throw new Error('금일 산불 현황 테이블은 찾았지만 파싱 가능한 행이 없습니다. JavaScript 렌더링 여부를 확인하세요.');
    }

    return rows;
}

function normalizeWildfireRow(row) {
    try {
        const dateParts = parseDateTime(row.occurredAt);
        const addressParts = parseAddress(row.address);

        return {
            ...dateParts,
            endyear: null,
            endmonth: null,
            endday: null,
            endtime: null,
            ...addressParts,
            firecause: null,
            damagearea: null
        };
    } catch (error) {
        console.error('[parser] 산불 행 정규화 실패:', error.message, row);
        return null;
    }
}

module.exports = {
    parseWildfireRows,
    normalizeWildfireRow,
    parseDateTime,
    parseAddress
};
