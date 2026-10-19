"""Edits LibreOffice documents through UNO and reports what changed.

The desktop launches LibreOffice with a named UNO pipe (a Unix socket in /tmp
owned by the desktop user), so edits land in the window the person sees. The
desktop egress guard refuses loopback TCP for that user, which rules out
unoserver's default port. Without an open office, the file is edited in a
private headless instance and saved.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.connection import NoConnectException

DESKTOP_PIPE = "openwork-office"
LIMIT = 200
PDF_FILTERS = {
    "com.sun.star.text.TextDocument": "writer_pdf_Export",
    "com.sun.star.sheet.SpreadsheetDocument": "calc_pdf_Export",
    "com.sun.star.presentation.PresentationDocument": "impress_pdf_Export",
    "com.sun.star.drawing.DrawingDocument": "draw_pdf_Export",
}


class Failure(Exception):
    pass


def prop(name, value):
    item = PropertyValue()
    item.Name = name
    item.Value = value
    return item


def connect(pipe, attempts=1):
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    for attempt in range(attempts):
        try:
            context = resolver.resolve(f"uno:pipe,name={pipe};urp;StarOffice.ComponentContext")
            return context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
        except NoConnectException:
            if attempt + 1 == attempts:
                return None
            time.sleep(0.25)


def find_open(desktop, path):
    url = uno.systemPathToFileUrl(path)
    components = desktop.getComponents().createEnumeration()
    while components.hasMoreElements():
        component = components.nextElement()
        if getattr(component, "URL", None) == url:
            return component
    return None


def kind(document):
    for service in PDF_FILTERS:
        if document.supportsService(service):
            return service
    raise Failure("This window is not a LibreOffice document.")


def sheet_range(document, args):
    if not document.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
        raise Failure("Cell ranges need a Calc spreadsheet.")
    sheets = document.getSheets()
    name = args.get("sheet")
    if name is not None and not sheets.hasByName(name):
        raise Failure(f"No sheet named {name!r}. Sheets: {list(sheets.getElementNames())}")
    sheet = sheets.getByName(name) if name is not None else document.getCurrentController().getActiveSheet()
    try:
        cells = sheet.getCellRangeByName(args["range"])
    except Exception:
        raise Failure("Use an A1-style range such as A1:C4.")
    address = cells.getRangeAddress()
    if (address.EndRow - address.StartRow + 1) * (address.EndColumn - address.StartColumn + 1) > 10_000:
        raise Failure("Use a range of at most 10000 cells.")
    return sheet, cells, address


def cell_name(column, row):
    letters = ""
    column += 1
    while column:
        column, rest = divmod(column - 1, 26)
        letters = chr(65 + rest) + letters
    return f"{letters}{row + 1}"


def values(cells):
    return [list(row) for row in cells.getDataArray()]


def operate(document, args):
    operation = args["operation"]
    if operation == "read_range":
        sheet, cells, _ = sheet_range(document, args)
        return {"sheet": sheet.getName(), "range": args["range"], "values": values(cells)}
    if operation == "write_range":
        sheet, cells, address = sheet_range(document, args)
        rows = args.get("values")
        height, width = address.EndRow - address.StartRow + 1, address.EndColumn - address.StartColumn + 1
        if not isinstance(rows, list) or len(rows) != height or any(not isinstance(row, list) or len(row) != width for row in rows):
            raise Failure(f"values must be {height} rows of {width} cells for {args['range']}.")
        before = values(cells)
        for r, row in enumerate(rows):
            for c, value in enumerate(row):
                cell = cells.getCellByPosition(c, r)
                if value is None:
                    continue
                if isinstance(value, bool) or not isinstance(value, (int, float, str)):
                    raise Failure("Cell values must be numbers, strings, formulas starting with = or null to keep a cell.")
                if isinstance(value, str) and value.startswith("="):
                    cell.setFormula(value)
                elif isinstance(value, str):
                    cell.setString(value)
                else:
                    cell.setValue(value)
        after = values(cells)
        changed = [{"cell": cell_name(address.StartColumn + c, address.StartRow + r), "before": before[r][c], "after": after[r][c]}
                   for r in range(height) for c in range(width) if before[r][c] != after[r][c]]
        return {"sheet": sheet.getName(), "range": args["range"], "changed": changed[:LIMIT], "changedCount": len(changed), "values": after}
    if operation == "insert_text":
        if not document.supportsService("com.sun.star.text.TextDocument"):
            raise Failure("insert_text needs a Writer document.")
        text = args.get("text")
        if not isinstance(text, str) or not text or len(text) > 100_000:
            raise Failure("Provide text of at most 100000 characters.")
        body = document.getText()
        before = len(body.getString())
        cursor = body.createTextCursor()
        cursor.gotoStart(False) if args.get("at") == "start" else cursor.gotoEnd(False)
        # Each line becomes its own paragraph, as if typed with Enter.
        for index, line in enumerate(text.split("\n")):
            if index:
                body.insertControlCharacter(cursor, 0, False)
            body.insertString(cursor, line, False)
        content = body.getString()
        return {"inserted": len(text), "at": args.get("at", "end"), "charactersBefore": before, "charactersAfter": len(content), "tail": content[-300:]}
    if operation == "export_pdf":
        output = args.get("output")
        if not isinstance(output, str) or not os.path.isabs(output) or not output.endswith(".pdf"):
            raise Failure("Provide an absolute output path ending in .pdf, usually in /workspace/out.")
        document.storeToURL(uno.systemPathToFileUrl(output), (prop("FilterName", PDF_FILTERS[kind(document)]),))
        return {"exported": output, "bytes": os.path.getsize(output)}
    raise Failure("Use read_range, write_range, insert_text or export_pdf.")


def main():
    args = json.load(sys.stdin)
    path = args.get("path")
    if path is not None and (not isinstance(path, str) or not os.path.isabs(path)):
        raise Failure("Use an absolute file path.")
    desktop = connect(DESKTOP_PIPE)
    office = None
    profile = None
    if desktop:
        document = (find_open(desktop, path) or desktop.loadComponentFromURL(uno.systemPathToFileUrl(path), "_default", 0, ())) if path else desktop.getCurrentComponent()
        target = "open window"
    else:
        if not path:
            raise Failure("No LibreOffice window is open. Pass path to edit a file directly, or open it with computer_launch.")
        profile = tempfile.mkdtemp(prefix="openwork-office-")
        pipe = f"openwork-office-{os.getpid()}"
        office = subprocess.Popen(["soffice", "--headless", "--invisible", "--norestore", "--nologo", "--nodefault",
                                   f"-env:UserInstallation={uno.systemPathToFileUrl(profile)}", f"--accept=pipe,name={pipe};urp;"],
                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        desktop = connect(pipe, attempts=120)
        if not desktop:
            raise Failure("LibreOffice did not start.")
        document = desktop.loadComponentFromURL(uno.systemPathToFileUrl(path), "_blank", 0, (prop("Hidden", True),))
        target = "file"
    try:
        if document is None or not hasattr(document, "supportsService"):
            raise Failure("No LibreOffice document is open. Open one with computer_launch, or pass path.")
        result = operate(document, args)
        result["document"] = uno.fileUrlToSystemPath(document.URL) if document.URL else None
        result["target"] = target
        if document.isModified() and (args.get("save") or target == "file"):
            if not document.URL:
                raise Failure("This document has never been saved; export it or save it from the window first.")
            document.store()
            result["saved"] = True
        result["unsaved"] = document.isModified()
        return result
    finally:
        if office:
            try:
                document.close(True)
                desktop.terminate()
            except Exception:
                pass
            office.kill()
            subprocess.run(["rm", "-rf", profile], check=False)


try:
    print(json.dumps({"ok": True, **main()}))
except Failure as error:
    print(json.dumps({"ok": False, "error": str(error)}))
except Exception as error:
    print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"[:2000]}))
