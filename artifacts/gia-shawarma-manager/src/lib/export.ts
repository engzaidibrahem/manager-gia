import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';

type Row = Record<string, string | number | null | undefined>;

export function exportRowsToExcel(rows: Row[], filename: string, sheetName = 'Data') {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

export function exportRowsToPdf(
  rows: Row[],
  filename: string,
  title: string,
  columns: { header: string; key: keyof Row }[],
) {
  const doc = new jsPDF({ orientation: columns.length > 5 ? 'landscape' : 'portrait' });
  doc.setFontSize(14);
  doc.text(title, 14, 16);
  autoTable(doc, {
    startY: 22,
    head: [columns.map((col) => col.header)],
    body: rows.map((row) => columns.map((col) => String(row[col.key] ?? ''))),
    styles: { fontSize: 9, cellPadding: 2 },
    headStyles: { fillColor: [180, 60, 30] },
  });
  doc.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
}
