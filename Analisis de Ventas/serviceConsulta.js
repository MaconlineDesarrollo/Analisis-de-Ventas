const sql  = require('mssql');
const util = require('util');

const config = {
    user: 'Sa',
    password: 'rGT_yryej@',
    server: '172.30.0.175',
    database: 'DESARROLLO_MOL',
    trustServerCertificate: true,
    requestTimeout: 120000,
    connectionTimeout: 30000,
};

const conectar = util.promisify(sql.connect);
const query    = util.promisify(sql.query);

// Valida formato YYYY-MM-DD para evitar SQL injection
function validarFecha(f) {
    return /^\d{4}-\d{2}-\d{2}$/.test(f) && !isNaN(Date.parse(f));
}

// Convierte 'YYYY-MM-DD' a 'YYYYMMDD' — formato sin ambigüedad en SQL Server
// y que permite uso de índice sin CAST en la columna
function toSQL(f) {
    return f.replace(/-/g, '');  // '2025-01-31' → '20250131'
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM — Sociedad MAC (POSOne_CC_MAC_HANA_PROD)
//
// Optimizaciones vs. versión anterior:
//  1. Subquery DET con IN → reemplazada por INNER JOIN directo a DOCUMENT
//     (elimina el escaneo correlacionado, la mayor causa de lentitud)
//  2. CAST(creation_date AS date) BETWEEN → creation_date >= X AND < X+1
//     (deja que SQL Server use el índice sobre creation_date)
//  3. Formato YYYYMMDD sin guiones — más eficiente en SQL Server linked servers
// ─────────────────────────────────────────────────────────────────────────────
async function consultarITEM(desde, hasta) {
    if (!validarFecha(desde) || !validarFecha(hasta))
        throw new Error('Fechas inválidas. Use formato YYYY-MM-DD.');

    await conectar(config);

    const d = toSQL(desde);
    const h = toSQL(hasta);

    const consultaSQL = `
        SELECT
            X.LOCAL AS 'Local',
            FORMAT(ROUND(X.Total_Venta, 0), 'N0', 'es-CL')                                                       AS [Total Venta],
            FORMAT(X.Cantidad_operaciones, 'N0', 'es-CL')                                                        AS [Nro. Operaciones],
            FORMAT(CAST(ROUND(X.Total_Venta / X.Cantidad_operaciones, 2) AS INT), 'N0', 'es-CL')                 AS [Promedio Venta],
            FORMAT(CAST(ROUND(X.Total_Iva   / X.Cantidad_operaciones, 2) AS INT), 'N0', 'es-CL')                 AS [Promedio IVA],
            REPLACE(REPLACE(ROUND(X.Cantidad_Item   / CONVERT(DECIMAL, X.Cantidad_operaciones), 2), '.', ','), '00000000000000000', '') AS [Prom. Lineas por Venta],
            REPLACE(REPLACE(ROUND(X.Cantidad_Unidad / X.Cantidad_operaciones,                   2), '.', ','), '0000', '')              AS [Prom. Unidades por Venta]
        FROM (
            SELECT
                S.description  AS LOCAL,
                S.field_user_1,
                SUM((D.total_free_tax + D.total_no_free_tax) *
                    (CASE WHEN DT.code LIKE 'NCR%' THEN -1 ELSE 1 END))                                          AS Total_Venta,
                COUNT(1)                                                                                           AS Cantidad_operaciones,
                ISNULL(SUM(D.total_tax * (CASE WHEN DT.code LIKE 'NCR%' THEN -1 ELSE 1 END)), 0)                 AS Total_iva,
                SUM(DET.lineas)                                                                                    AS Cantidad_Item,
                SUM(DET.unidades * (CASE WHEN DT.code LIKE 'NCR%' THEN -1 ELSE 1 END))                           AS Cantidad_Unidad
            FROM [10.166.57.70].[POSOne_CC_MAC_HANA_PROD].[dbo].DOCUMENT D
            INNER JOIN [10.166.57.70].[POSOne_CC_MAC_HANA_PROD].[dbo].STORE S
                ON S.ID = D.id_store AND S.POS_FlagLocal = 1
            INNER JOIN [10.166.57.70].[POSOne_CC_MAC_HANA_PROD].[dbo].DOCUMENT_TYPE DT
                ON DT.ID = D.id_document_type
                AND (DT.CODE LIKE 'BOL%' OR DT.CODE LIKE 'FAC%' OR DT.code LIKE 'NCR%')
            LEFT JOIN [10.166.57.70].[POSOne_CC_MAC_HANA_PROD].[dbo].PAYMENT_CONDITION PC
                ON PC.ID = D.id_payment_condition
            -- ► OPTIMIZACIÓN: JOIN directo en lugar de IN (subquery)
            INNER JOIN (
                SELECT
                    DD.id_document,
                    COUNT(1)                                                               AS lineas,
                    SUM(CASE WHEN I.code = 'KABONO' THEN 0 ELSE DD.quantity END)          AS unidades
                FROM [10.166.57.70].[POSOne_CC_MAC_HANA_PROD].[dbo].DOCUMENTDET DD
                INNER JOIN [10.166.57.70].[POSOne_CC_MAC_HANA_PROD].[dbo].ITEM I
                    ON I.ID = DD.ID_ITEM
                -- ► JOIN a DOCUMENT para filtrar por fecha sin subquery IN
                INNER JOIN [10.166.57.70].[POSOne_CC_MAC_HANA_PROD].[dbo].DOCUMENT D2
                    ON D2.id = DD.id_document
                INNER JOIN [10.166.57.70].[POSOne_CC_MAC_HANA_PROD].[dbo].STORE S2
                    ON S2.ID = D2.id_store AND S2.POS_FlagLocal = 1
                INNER JOIN [10.166.57.70].[POSOne_CC_MAC_HANA_PROD].[dbo].DOCUMENT_TYPE DT2
                    ON DT2.ID = D2.id_document_type
                    AND (DT2.CODE LIKE 'BOL%' OR DT2.CODE LIKE 'FAC%' OR DT2.code LIKE 'NCR%')
                WHERE D2.transmited >= 0
                    -- ► Sin CAST en la columna → usa índice sobre creation_date
                    AND D2.creation_date >= '${d}' AND D2.creation_date < DATEADD(day, 1, CAST('${h}' AS date))
                GROUP BY DD.id_document
            ) AS DET ON DET.id_document = D.ID
            WHERE D.transmited >= 0
                AND D.creation_date >= '${d}' AND D.creation_date < DATEADD(day, 1, CAST('${h}' AS date))
            GROUP BY S.description, S.field_user_1
        ) AS X
        ORDER BY X.Total_Venta DESC;
    `;

    const result = await query(consultaSQL);
    sql.close();
    return result.recordset;
}

// ─────────────────────────────────────────────────────────────────────────────
// QD — Sociedad BACK (POSOne_CC_BACK_HANA_PROD) + Web Shopify
// Mismas optimizaciones que ITEM
// ─────────────────────────────────────────────────────────────────────────────
async function consultarQD(desde, hasta) {
    if (!validarFecha(desde) || !validarFecha(hasta))
        throw new Error('Fechas inválidas. Use formato YYYY-MM-DD.');

    await conectar(config);

    const d = toSQL(desde);
    const h = toSQL(hasta);

    const consultaSQL = `
        -- Canal Web (Shopify)
        SELECT
            'Web' AS 'Local',
            ROUND(SUM(CAST(os.current_total_price AS INT)) / 1.19, 0) AS [Total Venta],
            COUNT(os.confirmed) AS 'Nro. Operaciones',
            CAST(ROUND(
                CASE WHEN COUNT(os.confirmed) = 0 THEN 0
                     ELSE SUM(CAST(os.current_total_price AS INT)) / 1.19 * 1.0 / COUNT(os.confirmed)
                END, 2) AS INT) AS [Promedio Venta],
            REPLACE(REPLACE(
                ROUND(CASE WHEN COUNT(os.confirmed) = 0 THEN 0
                           ELSE COUNT(os.line_item_count) * 1.0 / COUNT(os.confirmed)
                      END, 2), '.', ','), '0000', '') AS [Prom. Unidades por Venta]
        FROM orders_shopify os
        -- ► Sin CAST en la columna
        WHERE os.created_at >= '${d}' AND os.created_at < DATEADD(day, 1, CAST('${h}' AS date))

        UNION ALL

        -- Canal Tiendas Físicas BACK
        SELECT
            X.LOCAL AS 'Local',
            ROUND(X.Total_Venta, 0)                                                                              AS [Total Venta],
            X.Cantidad_operaciones                                                                                AS 'Nro. Operaciones',
            CAST(ROUND(X.Total_Venta / X.Cantidad_operaciones, 2) AS INT)                                        AS [Promedio Venta],
            REPLACE(REPLACE(ROUND(X.Cantidad_Unidad / X.Cantidad_operaciones, 2), '.', ','), '0000', '')         AS [Prom. Unidades por Venta]
        FROM (
            SELECT
                S.description                                                                                     AS LOCAL,
                SUM((D.total_free_tax + D.total_no_free_tax) *
                    (CASE WHEN DT.code LIKE 'NCR%' THEN -1 ELSE 1 END))                                          AS Total_Venta,
                COUNT(1)                                                                                           AS Cantidad_operaciones,
                SUM(DET.unidades * (CASE WHEN DT.code LIKE 'NCR%' THEN -1 ELSE 1 END))                           AS Cantidad_Unidad
            FROM [10.166.57.70].[POSOne_CC_BACK_HANA_PROD].[dbo].DOCUMENT D
            INNER JOIN [10.166.57.70].[POSOne_CC_BACK_HANA_PROD].[dbo].STORE S
                ON S.ID = D.id_store AND S.POS_FlagLocal = 1 and S2.id<>'53'
            INNER JOIN [10.166.57.70].[POSOne_CC_BACK_HANA_PROD].[dbo].DOCUMENT_TYPE DT
                ON DT.ID = D.id_document_type
                AND (DT.CODE LIKE 'BOL%' OR DT.CODE LIKE 'FAC%' OR DT.code LIKE 'NCR%')
            LEFT JOIN [10.166.57.70].[POSOne_CC_BACK_HANA_PROD].[dbo].PAYMENT_CONDITION PC
                ON PC.ID = D.id_payment_condition
            -- ► OPTIMIZACIÓN: JOIN directo en lugar de IN (subquery)
            INNER JOIN (
                SELECT
                    DD.id_document,
                    COUNT(1)                                                               AS lineas,
                    SUM(CASE WHEN I.code = 'KABONO' THEN 0 ELSE DD.quantity END)          AS unidades
                FROM [10.166.57.70].[POSOne_CC_BACK_HANA_PROD].[dbo].DOCUMENTDET DD
                INNER JOIN [10.166.57.70].[POSOne_CC_BACK_HANA_PROD].[dbo].ITEM I
                    ON I.ID = DD.ID_ITEM
                INNER JOIN [10.166.57.70].[POSOne_CC_BACK_HANA_PROD].[dbo].DOCUMENT D2
                    ON D2.id = DD.id_document
                INNER JOIN [10.166.57.70].[POSOne_CC_BACK_HANA_PROD].[dbo].STORE S2
                    ON S2.ID = D2.id_store AND S2.POS_FlagLocal = 1 and S2.id<>'53'
                INNER JOIN [10.166.57.70].[POSOne_CC_BACK_HANA_PROD].[dbo].DOCUMENT_TYPE DT2
                    ON DT2.ID = D2.id_document_type
                    AND (DT2.CODE LIKE 'BOL%' OR DT2.CODE LIKE 'FAC%' OR DT2.code LIKE 'NCR%')
                WHERE D2.transmited >= 0
                    AND D2.creation_date >= '${d}' AND D2.creation_date < DATEADD(day, 1, CAST('${h}' AS date))
                GROUP BY DD.id_document
            ) AS DET ON DET.id_document = D.ID
            WHERE D.transmited >= 0
                AND D.creation_date >= '${d}' AND D.creation_date < DATEADD(day, 1, CAST('${h}' AS date))
            GROUP BY S.description
        ) AS X
        ORDER BY [Total Venta] DESC
    `;

    const result = await query(consultaSQL);
    sql.close();
    return result.recordset;
}

module.exports = { consultarITEM, consultarQD };