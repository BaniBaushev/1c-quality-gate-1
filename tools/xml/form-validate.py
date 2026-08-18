#!/usr/bin/env python3
# form-validate v1.8 — Validate 1C managed form
# Source: https://github.com/Nikolay-Shirokov/cc-1c-skills
# Copyright (c) 2025-2026 Nick Shirokov. Licensed under the MIT License.
# Адаптировано для плагина 1c-quality-gate; изменения (c) 2026 romandredan, MIT.

import argparse
import os
import re
import sys
from lxml import etree

F_NS = "http://v8.1c.ru/8.3/xcf/logform"
V8_NS = "http://v8.1c.ru/8.1/data/core"

NSMAP = {"f": F_NS, "v8": V8_NS}

# --- Связность Form.xml и модуля формы -------------------------------------
#
# Имя обработчика и имя действия команды объявлены в XML, а процедура живёт в модуле: обе
# стороны связи записаны явно, но не сверяет их никто. Валидатор структуры проверяет, что
# XML соответствует схеме, — ссылка на несуществующую процедуру схеме соответствует.
#
# Замер на живом коде (5 066 форм типовой конфигурации, 60 422 связи): не разрешилось 23,
# все — в объектах сторонних доработок, в типовых объектах ни одной. Так что ложные
# срабатывания редки, но не «отсутствуют по построению»: см. оговорку про базовую форму ниже.

BSL_DECL_RE = re.compile(
    r'(?<![A-Za-zА-Яа-яЁё0-9_])(?:Процедура|Функция)\s+([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)\s*\(',
    re.IGNORECASE,
)
CONFIG_MARKER_XML = "Configuration.xml"
EXTENSION_MARKER_XML = "<ConfigurationExtensionPurpose"


def normalize_name(name):
    """BSL регистронезависим, а «ё» и «е» различает: гасим регистр, но не букву."""
    return (name or "").strip().lower()


def mask_bsl(source):
    """Гасит комментарии и строковые литералы, сохраняя длину.

    Без этого объявление, стоящее после строки с `//` внутри литерала (URL, например),
    терялось бы вместе с остатком строки, а слово из русского текста перед скобкой
    становилось бы объявлением. Отказ в обе стороны молчаливый.
    """
    chars = list(source)
    i = 0
    in_string = False
    while i < len(chars):
        if not in_string and chars[i] == '/' and i + 1 < len(chars) and chars[i + 1] == '/':
            while i < len(chars) and chars[i] != '\n':
                chars[i] = ' '
                i += 1
            continue
        if chars[i] == '"':
            if in_string and i + 1 < len(chars) and chars[i + 1] == '"':
                chars[i] = chars[i + 1] = ' '
                i += 2
                continue
            chars[i] = ' '
            in_string = not in_string
            i += 1
            continue
        if in_string and chars[i] != '\n':
            chars[i] = ' '
        i += 1
    return "".join(chars)


def module_declarations(module_path):
    """Имена процедур и функций модуля. None — файла нет (это не то же, что пустой модуль)."""
    if not module_path or not os.path.isfile(module_path):
        return None
    try:
        with open(module_path, encoding="utf-8-sig", errors="replace") as fh:
            source = fh.read()
    except OSError:
        return None
    return {normalize_name(m.group(1)) for m in BSL_DECL_RE.finditer(mask_bsl(source))}


def config_root_of(path, marker_extension=None):
    """Корень конфигурации или расширения над файлом. `marker_extension`: True/False/None."""
    current = os.path.dirname(os.path.abspath(path))
    for _ in range(15):
        marker = os.path.join(current, CONFIG_MARKER_XML)
        if os.path.isfile(marker):
            head = ""
            try:
                with open(marker, encoding="utf-8-sig", errors="replace") as fh:
                    head = fh.read(8192)
            except OSError:
                pass
            is_extension = EXTENSION_MARKER_XML in head
            if marker_extension is None or is_extension == marker_extension:
                return current
            return None
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent
    return None


def main_config_root(start, depth=4):
    """Ищет корень ОСНОВНОЙ конфигурации в проекте — обход сверху, как у analyzer-run.mjs."""
    skip = {".git", ".claude", "node_modules", "build", "out", "dist", ".qg-analyzer"}
    stack = [(os.path.abspath(start), 0)]
    while stack:
        current, level = stack.pop()
        if level > depth:
            continue
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        marker = os.path.join(current, CONFIG_MARKER_XML)
        if os.path.isfile(marker):
            head = ""
            try:
                with open(marker, encoding="utf-8-sig", errors="replace") as fh:
                    head = fh.read(8192)
            except OSError:
                pass
            if EXTENSION_MARKER_XML not in head:
                return current
            continue  # внутрь корня не спускаемся
        for entry in entries:
            if entry.is_dir() and entry.name not in skip and not entry.name.startswith("."):
                stack.append((entry.path, level + 1))
    return None


def base_form_declarations(form_path):
    """Объявления модуля БАЗОВОЙ формы для формы расширения.

    Зачем. Модуль формы расширения сливается с модулем расширяемой формы, и обработчик,
    названный в XML расширения, может быть объявлен в базовом модуле — законно. Замер:
    1 такой случай из 9 находок на заимствованных формах живого проекта. Без этого разрешения
    находка была бы ложной и блокирующей.

    Возвращает (множество имён, состояние): состояние `resolved` | `no_main_configuration`.
    """
    ext_root = config_root_of(form_path, marker_extension=True)
    if not ext_root:
        return set(), "resolved"  # форма не в расширении — базовой формы нет по определению
    candidates = []
    try:
        from _qg_journal import project_root

        candidates.append(project_root(os.path.dirname(os.path.abspath(form_path))))
    except ImportError:
        pass
    walk_up = os.path.abspath(ext_root)
    for _ in range(3):
        walk_up = os.path.dirname(walk_up)
        candidates.append(walk_up)

    main_root = None
    for candidate in candidates:
        main_root = main_config_root(candidate)
        if main_root:
            break
    if not main_root:
        return set(), "no_main_configuration"
    relative = os.path.relpath(os.path.dirname(os.path.abspath(form_path)), ext_root)
    declared = module_declarations(os.path.join(main_root, relative, "Form", "Module.bsl"))
    return (declared or set()), "resolved"


KNOWN_INVALID_TYPES = {
    'FormDataStructure', 'FormDataCollection', 'FormDataTree',
    'FormDataTreeItem', 'FormDataCollectionItem',
    'FormGroup', 'FormField', 'FormButton', 'FormDecoration', 'FormTable',
}

VALID_CLOSED_TYPES = {
    'xs:boolean', 'xs:string', 'xs:decimal', 'xs:dateTime', 'xs:binary',
    'v8:FillChecking', 'v8:Null', 'v8:StandardPeriod', 'v8:StandardBeginningDate', 'v8:Type',
    'v8:TypeDescription', 'v8:UUID', 'v8:ValueListType', 'v8:ValueTable', 'v8:ValueTree',
    'v8:Universal', 'v8:FixedArray', 'v8:FixedStructure',
    'v8ui:Color', 'v8ui:Font', 'v8ui:FormattedString', 'v8ui:HorizontalAlign',
    'v8ui:Picture', 'v8ui:SizeChangeMode', 'v8ui:VerticalAlign',
    'dcsset:DataCompositionComparisonType', 'dcsset:DataCompositionFieldPlacement',
    'dcsset:Filter', 'dcsset:SettingsComposer', 'dcsset:DataCompositionSettings',
    'dcssch:DataCompositionSchema',
    'dcscor:DataCompositionComparisonType', 'dcscor:DataCompositionGroupType',
    'dcscor:DataCompositionPeriodAdditionType', 'dcscor:DataCompositionSortDirection', 'dcscor:Field',
    'ent:AccountType', 'ent:AccumulationRecordType', 'ent:AccountingRecordType',
}

VALID_CFG_PREFIXES = {
    'AccountingRegisterRecordSet', 'AccumulationRegisterRecordSet',
    'BusinessProcessObject', 'BusinessProcessRef',
    'CatalogObject', 'CatalogRef',
    'ChartOfAccountsObject', 'ChartOfAccountsRef',
    'ChartOfCalculationTypesObject', 'ChartOfCalculationTypesRef',
    'ChartOfCharacteristicTypesObject', 'ChartOfCharacteristicTypesRef',
    'ConstantsSet', 'DataProcessorObject', 'DocumentObject', 'DocumentRef',
    'DynamicList', 'EnumRef', 'ExchangePlanObject', 'ExchangePlanRef',
    'ExternalDataProcessorObject', 'ExternalReportObject',
    'InformationRegisterRecordManager', 'InformationRegisterRecordSet',
    'ReportObject', 'TaskObject', 'TaskRef',
}


def localname(el):
    return etree.QName(el.tag).localname


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Validate 1C managed form", allow_abbrev=False)
    parser.add_argument("-FormPath", "-Path", required=True)
    parser.add_argument("-Detailed", action="store_true")
    parser.add_argument("-MaxErrors", type=int, default=30)
    args = parser.parse_args()

    form_path = args.FormPath
    detailed = args.Detailed
    max_errors = args.MaxErrors

    if not os.path.isabs(form_path):
        form_path = os.path.join(os.getcwd(), form_path)

    # A: Directory → Ext/Form.xml
    if os.path.isdir(form_path):
        form_path = os.path.join(form_path, 'Ext', 'Form.xml')
    # B1: Missing Ext/ (e.g. Forms/Форма/Form.xml → Forms/Форма/Ext/Form.xml)
    if not os.path.exists(form_path):
        fn = os.path.basename(form_path)
        if fn == 'Form.xml':
            c = os.path.join(os.path.dirname(form_path), 'Ext', fn)
            if os.path.exists(c):
                form_path = c
    # B2: Descriptor (Forms/Форма.xml → Forms/Форма/Ext/Form.xml)
    if not os.path.exists(form_path) and form_path.endswith('.xml'):
        stem = os.path.splitext(os.path.basename(form_path))[0]
        parent = os.path.dirname(form_path)
        c = os.path.join(parent, stem, 'Ext', 'Form.xml')
        if os.path.exists(c):
            form_path = c

    if not os.path.isfile(form_path):
        print(f"File not found: {form_path}", file=sys.stderr)
        sys.exit(1)

    # --- Load XML ---
    try:
        xml_parser = etree.XMLParser(remove_blank_text=True)
        tree = etree.parse(form_path, xml_parser)
    except Exception as e:
        print(f"[ERROR] XML parse error: {e}")
        print()
        print("---")
        print("Errors: 1, Warnings: 0")
        sys.exit(1)

    root = tree.getroot()

    # Detect context: config vs EPF/ERF
    is_config_context = False
    walk_dir = os.path.dirname(os.path.abspath(form_path))
    for _ in range(15):
        parent = os.path.dirname(walk_dir)
        if parent == walk_dir:
            break
        if os.path.isfile(os.path.join(walk_dir, 'Configuration.xml')):
            is_config_context = True
            break
        walk_dir = parent

    errors = 0
    warnings = 0
    ok_count = 0
    stopped = False
    output_lines = []

    def report_ok(msg):
        nonlocal ok_count
        ok_count += 1
        if detailed:
            output_lines.append(f"[OK]    {msg}")

    def report_error(msg):
        nonlocal errors, stopped
        errors += 1
        output_lines.append(f"[ERROR] {msg}")
        if errors >= max_errors:
            stopped = True

    def report_warn(msg):
        nonlocal warnings
        warnings += 1
        output_lines.append(f"[WARN]  {msg}")

    # --- Form name from path ---
    form_name = os.path.splitext(os.path.basename(form_path))[0]
    parent_dir = os.path.dirname(form_path)
    if parent_dir:
        ext_dir = os.path.basename(parent_dir)
        if ext_dir == "Ext":
            form_dir = os.path.dirname(parent_dir)
            if form_dir:
                form_name = os.path.basename(form_dir)

    output_lines.append(f"=== Validation: Form.{form_name} ===")
    output_lines.append("")

    # Early BaseForm detection
    has_base_form = root.find(f"{{{F_NS}}}BaseForm") is not None

    # --- Check 1: Root element and version ---
    if localname(root) != "Form":
        report_error(f"Root element is '{localname(root)}', expected 'Form'")
    else:
        version = root.get("version", "")
        if version in ("2.17", "2.20"):
            report_ok(f"Root element: Form version={version}")
        elif version:
            report_warn(f"Form version='{version}' (expected 2.17 or 2.20)")
        else:
            report_warn("Form version attribute missing")

    # --- Check 2: AutoCommandBar ---
    if not stopped:
        acb = root.find(f"{{{F_NS}}}AutoCommandBar")
        if acb is not None:
            acb_name = acb.get("name", "")
            acb_id = acb.get("id", "")
            if acb_id == "-1":
                report_ok(f"AutoCommandBar: name='{acb_name}', id={acb_id}")
            else:
                report_error(f"AutoCommandBar id='{acb_id}', expected '-1'")
        else:
            report_error("AutoCommandBar element missing")

    # --- Collect all elements with IDs ---
    element_ids = {}    # id -> name
    element_names = {}  # name -> id (имена элементов уникальны в пределах формы)
    all_elements = []  # list of dicts {Name, Tag, Id, ParentName, Node}

    def collect_elements(node, parent_name):
        nonlocal stopped
        for child in node:
            if not isinstance(child.tag, str):
                continue

            name = child.get("name", "")
            eid = child.get("id", "")

            if name and eid:
                tag = localname(child)

                all_elements.append({
                    "Name": name,
                    "Tag": tag,
                    "Id": eid,
                    "ParentName": parent_name,
                    "Node": child,
                })

                if eid != "-1":
                    if eid in element_ids:
                        report_error(f"Duplicate element id={eid}: '{name}' and '{element_ids[eid]}'")
                    else:
                        element_ids[eid] = name

                    # Имена элементов уникальны (требование 1С)
                    if name in element_names:
                        report_error(f"Duplicate element name '{name}': id={eid} and id={element_names[name]}")
                    else:
                        element_names[name] = eid

                child_items = child.find(f"{{{F_NS}}}ChildItems")
                if child_items is not None:
                    collect_elements(child_items, name)

    child_items_root = root.find(f"{{{F_NS}}}ChildItems")
    if child_items_root is not None:
        collect_elements(child_items_root, "(root)")

    acb = root.find(f"{{{F_NS}}}AutoCommandBar")
    if acb is not None:
        acb_children = acb.find(f"{{{F_NS}}}ChildItems")
        if acb_children is not None:
            collect_elements(acb_children, "\u0424\u043e\u0440\u043c\u0430\u041a\u043e\u043c\u0430\u043d\u0434\u043d\u0430\u044f\u041f\u0430\u043d\u0435\u043b\u044c")

    # --- Check 3: Unique element IDs ---
    if not stopped:
        # Duplicates already reported during collection
        dup_count = 0
        id_counts = {}
        for el in all_elements:
            eid = el["Id"]
            if eid == "-1":
                continue
            id_counts[eid] = id_counts.get(eid, 0) + 1
        dup_count = sum(1 for v in id_counts.values() if v > 1)
        if dup_count == 0:
            report_ok(f"Unique element IDs: {len(element_ids)} elements")

    # --- Collect attributes (separate ID pool) ---
    attr_map = {}   # name -> node
    attr_ids = {}   # id -> name

    attr_nodes_parent = root.find(f"{{{F_NS}}}Attributes")
    attr_nodes = []
    if attr_nodes_parent is not None:
        attr_nodes = attr_nodes_parent.findall(f"{{{F_NS}}}Attribute")

    for attr in attr_nodes:
        attr_name = attr.get("name", "")
        attr_id = attr.get("id", "")
        if attr_name:
            # Имена реквизитов уникальны среди реквизитов (отдельный неймспейс от элементов)
            if attr_name in attr_map:
                report_error(f"Duplicate attribute name '{attr_name}': id={attr_id} and id={attr_map[attr_name].get('id', '')}")
            attr_map[attr_name] = attr
        if attr_id:
            if attr_id in attr_ids:
                report_error(f"Duplicate attribute id={attr_id}: '{attr_name}' and '{attr_ids[attr_id]}'")
            else:
                attr_ids[attr_id] = attr_name

        # Column IDs uniqueness within parent
        col_ids = {}
        col_names = {}  # имена колонок уникальны в пределах своего реквизита
        columns = attr.find(f"{{{F_NS}}}Columns")
        if columns is not None:
            for col in columns.findall(f"{{{F_NS}}}Column"):
                col_id = col.get("id", "")
                col_name = col.get("name", "")
                if col_id:
                    if col_id in col_ids:
                        report_error(f"Duplicate column id={col_id} in '{attr_name}': '{col_name}' and '{col_ids[col_id]}'")
                    else:
                        col_ids[col_id] = col_name
                if col_name:
                    if col_name in col_names:
                        report_error(f"Duplicate column name '{col_name}' in '{attr_name}': id={col_id} and id={col_names[col_name]}")
                    else:
                        col_names[col_name] = col_id

    if not stopped:
        if attr_ids:
            report_ok(f"Unique attribute IDs: {len(attr_ids)} entries")

    # --- Collect commands (separate ID pool) ---
    cmd_map = {}   # name -> node
    cmd_ids = {}   # id -> name

    cmd_nodes_parent = root.find(f"{{{F_NS}}}Commands")
    cmd_nodes = []
    if cmd_nodes_parent is not None:
        cmd_nodes = cmd_nodes_parent.findall(f"{{{F_NS}}}Command")

    for cmd in cmd_nodes:
        cmd_name = cmd.get("name", "")
        cmd_id = cmd.get("id", "")
        if cmd_name:
            # Имена команд уникальны среди команд (отдельный неймспейс)
            if cmd_name in cmd_map:
                report_error(f"Duplicate command name '{cmd_name}': id={cmd_id} and id={cmd_map[cmd_name].get('id', '')}")
            cmd_map[cmd_name] = cmd
        if cmd_id:
            if cmd_id in cmd_ids:
                report_error(f"Duplicate command id={cmd_id}: '{cmd_name}' and '{cmd_ids[cmd_id]}'")
            else:
                cmd_ids[cmd_id] = cmd_name

    if not stopped:
        if cmd_ids:
            report_ok(f"Unique command IDs: {len(cmd_ids)} entries")

    # --- Collect parameters (separate name pool, без id) ---
    param_names = {}  # name -> True (имена параметров уникальны среди параметров)
    params_parent = root.find(f"{{{F_NS}}}Parameters")
    if params_parent is not None:
        for param in params_parent.findall(f"{{{F_NS}}}Parameter"):
            param_name = param.get("name", "")
            if param_name:
                if param_name in param_names:
                    report_error(f"Duplicate parameter name '{param_name}'")
                else:
                    param_names[param_name] = True

    # --- Check 4: Companion elements ---
    companion_rules = {
        "InputField": ["ContextMenu", "ExtendedTooltip"],
        "CheckBoxField": ["ContextMenu", "ExtendedTooltip"],
        "LabelDecoration": ["ContextMenu", "ExtendedTooltip"],
        "LabelField": ["ContextMenu", "ExtendedTooltip"],
        "PictureDecoration": ["ContextMenu", "ExtendedTooltip"],
        "PictureField": ["ContextMenu", "ExtendedTooltip"],
        "CalendarField": ["ContextMenu", "ExtendedTooltip"],
        "UsualGroup": ["ExtendedTooltip"],
        "Pages": ["ExtendedTooltip"],
        "Page": ["ExtendedTooltip"],
        "Button": ["ExtendedTooltip"],
        "Table": ["ContextMenu", "AutoCommandBar", "SearchStringAddition", "ViewStatusAddition", "SearchControlAddition"],
    }

    if not stopped:
        companion_errors = 0
        companion_checked = 0

        for el in all_elements:
            if stopped:
                break
            tag = el["Tag"]
            el_name = el["Name"]
            node = el["Node"]

            if tag not in companion_rules:
                continue

            required = companion_rules[tag]
            companion_checked += 1

            for comp_tag in required:
                comp_node = node.find(f"{{{F_NS}}}{comp_tag}")
                if comp_node is None:
                    report_error(f"[{tag}] '{el_name}': missing companion <{comp_tag}>")
                    companion_errors += 1

        if companion_errors == 0 and companion_checked > 0:
            report_ok(f"Companion elements: {companion_checked} elements checked")

    # --- Check 5: DataPath -> Attribute references ---
    if not stopped:
        path_errors = 0
        path_checked = 0
        path_base_skipped = 0

        # All data-binding tags whose value is an attribute path (root must exist in <Attributes>).
        binding_tags = ["DataPath", "TitleDataPath", "FooterDataPath", "HeaderDataPath",
                        "MultipleValueDataPath", "MultipleValuePresentDataPath", "RowPictureDataPath", "MultipleValuePictureDataPath"]

        skip_tags = {"ContextMenu", "ExtendedTooltip", "AutoCommandBar", "SearchStringAddition", "ViewStatusAddition", "SearchControlAddition"}

        for el in all_elements:
            if stopped:
                break
            tag = el["Tag"]
            el_name = el["Name"]
            node = el["Node"]

            if tag in skip_tags:
                continue

            if has_base_form and el["Id"]:
                try:
                    if int(el["Id"]) < 1000000:
                        path_base_skipped += 1
                        continue
                except (ValueError, TypeError):
                    pass

            for b_tag in binding_tags:
                if stopped:
                    break
                dp_node = node.find(f"{{{F_NS}}}{b_tag}")
                if dp_node is None:
                    continue

                data_path = (dp_node.text or "").strip()
                if not data_path:
                    continue

                # Opaque platform-internal shapes — not validatable from Form.xml alone:
                #   - bare numeric (e.g. "10", "1000003") — internal index
                #   - "N/M:<uuid>" — metadata reference by UUID
                if re.match(r'^\d+$', data_path) or re.match(r'^\d+/\d+:[0-9a-fA-F-]+$', data_path):
                    continue

                path_checked += 1

                clean_path = re.sub(r'\[\d+\]', '', data_path)
                # Strip leading '~' (current row of DynamicList: ~Список.Поле)
                if clean_path.startswith('~'):
                    clean_path = clean_path[1:]
                segments = clean_path.split(".")
                root_attr = segments[0]

                # Resolve Items.<TableName>.CurrentData.<Field>... — table element, not attribute
                if root_attr == 'Items':
                    if len(segments) < 3 or segments[2] != 'CurrentData':
                        report_warn(f"[{tag}] '{el_name}': {b_tag}='{data_path}' — unknown Items.* shape, expected Items.<Table>.CurrentData.*")
                        continue
                    table_name = segments[1]
                    table_el = None
                    for candidate in all_elements:
                        if candidate["Tag"] == 'Table' and candidate["Name"] == table_name:
                            table_el = candidate
                            break
                    if table_el is None:
                        report_error(f"[{tag}] '{el_name}': {b_tag}='{data_path}' — table element '{table_name}' not found")
                        path_errors += 1
                        continue
                    table_dp_node = table_el["Node"].find(f"{{{F_NS}}}DataPath")
                    if table_dp_node is None or not (table_dp_node.text or "").strip():
                        continue
                    table_dp = re.sub(r'\[\d+\]', '', (table_dp_node.text or "").strip())
                    if table_dp.startswith('~'):
                        table_dp = table_dp[1:]
                    root_attr = table_dp.split(".")[0]

                if root_attr not in attr_map:
                    report_error(f"[{tag}] '{el_name}': {b_tag}='{data_path}' — attribute '{root_attr}' not found")
                    path_errors += 1

        path_msg = ""
        if path_checked > 0:
            path_msg = f"{path_checked} paths checked"
        if path_base_skipped > 0:
            skip_note = f"{path_base_skipped} base skipped"
            path_msg = f"{path_msg}, {skip_note}" if path_msg else skip_note
        if path_errors == 0 and path_msg:
            report_ok(f"Data bindings: {path_msg}")

    # --- Check 6: Button command references ---
    if not stopped:
        cmd_errors = 0
        cmd_checked = 0

        for el in all_elements:
            if stopped:
                break
            tag = el["Tag"]
            el_name = el["Name"]
            node = el["Node"]

            if tag != "Button":
                continue

            cmd_node = node.find(f"{{{F_NS}}}CommandName")
            if cmd_node is None:
                continue

            cmd_ref = (cmd_node.text or "").strip()
            if not cmd_ref:
                continue

            m = re.match(r'^Form\.Command\.(.+)$', cmd_ref)
            if m:
                cmd_name_ref = m.group(1)
                cmd_checked += 1
                if cmd_name_ref not in cmd_map:
                    report_error(f"[Button] '{el_name}': CommandName='{cmd_ref}' \u2014 command '{cmd_name_ref}' not found in Commands")
                    cmd_errors += 1

        if cmd_errors == 0 and cmd_checked > 0:
            report_ok(f"Command references: {cmd_checked} buttons checked")

    # --- Check 7: Events have handler names ---
    if not stopped:
        event_errors = 0
        event_checked = 0

        # Form-level events
        form_events = root.find(f"{{{F_NS}}}Events")
        if form_events is not None:
            for evt in form_events.findall(f"{{{F_NS}}}Event"):
                evt_name = evt.get("name", "")
                handler = (evt.text or "").strip()
                event_checked += 1
                if not handler:
                    report_error(f"Form event '{evt_name}': empty handler name")
                    event_errors += 1

        # Element-level events
        for el in all_elements:
            if stopped:
                break
            tag = el["Tag"]
            el_name = el["Name"]
            node = el["Node"]

            events_node = node.find(f"{{{F_NS}}}Events")
            if events_node is None:
                continue

            for evt in events_node.findall(f"{{{F_NS}}}Event"):
                evt_name = evt.get("name", "")
                handler = (evt.text or "").strip()
                event_checked += 1
                if not handler:
                    report_error(f"[{tag}] '{el_name}' event '{evt_name}': empty handler name")
                    event_errors += 1

        if event_errors == 0 and event_checked > 0:
            report_ok(f"Event handlers: {event_checked} events checked")

    # --- Check 8: Command actions ---
    if not stopped:
        action_errors = 0
        action_checked = 0

        for cmd in cmd_nodes:
            if stopped:
                break
            cmd_name = cmd.get("name", "")
            action_node = cmd.find(f"{{{F_NS}}}Action")
            action_checked += 1
            if action_node is None or not (action_node.text or "").strip():
                report_error(f"Command '{cmd_name}': missing or empty Action")
                action_errors += 1

        if action_errors == 0 and action_checked > 0:
            report_ok(f"Command actions: {action_checked} commands checked")

    # --- Check 9: MainAttribute count ---
    if not stopped:
        main_count = 0
        for attr in attr_nodes:
            main_node = attr.find(f"{{{F_NS}}}MainAttribute")
            if main_node is not None and (main_node.text or "") == "true":
                main_count += 1

        if main_count <= 1:
            main_info = "1 main attribute" if main_count == 1 else "no main attribute"
            report_ok(f"MainAttribute: {main_info}")
        else:
            report_error(f"Multiple MainAttribute=true ({main_count} found, expected 0 or 1)")

    # --- Check 10: Title must be multilingual XML ---
    if not stopped:
        title_node = root.find(f"{{{F_NS}}}Title")
        if title_node is not None:
            v8_items = title_node.findall(f"{{{V8_NS}}}item")
            if len(v8_items) == 0 and (title_node.text or "").strip():
                report_error(f"Form Title is plain text ('{(title_node.text or '').strip()}') \u2014 must be multilingual XML (<v8:item>). Use top-level 'title' key in form-compile DSL.")
            else:
                report_ok("Title: multilingual XML")

    # --- Check 11: Extension-specific validations ---
    base_form_node = root.find(f"{{{F_NS}}}BaseForm")
    is_extension = base_form_node is not None

    if not stopped and is_extension:
        # 11a. BaseForm version
        bf_version = base_form_node.get("version", "")
        if bf_version:
            report_ok(f"BaseForm: version={bf_version}")
        else:
            report_warn("BaseForm: version attribute missing")

        # 11b. callType values validation
        valid_call_types = {"Before", "After", "Override"}
        ct_errors = 0
        ct_checked = 0

        form_events_node = root.find(f"{{{F_NS}}}Events")
        if form_events_node is not None:
            for evt in form_events_node.findall(f"{{{F_NS}}}Event"):
                ct = evt.get("callType", "")
                if ct:
                    ct_checked += 1
                    if ct not in valid_call_types:
                        report_error(f"Form event '{evt.get('name', '')}': invalid callType='{ct}' (expected: Before, After, Override)")
                        ct_errors += 1

        for el in all_elements:
            if stopped:
                break
            events_node = el["Node"].find(f"{{{F_NS}}}Events")
            if events_node is None:
                continue
            for evt in events_node.findall(f"{{{F_NS}}}Event"):
                ct = evt.get("callType", "")
                if ct:
                    ct_checked += 1
                    if ct not in valid_call_types:
                        report_error(f"[{el['Tag']}] '{el['Name']}' event '{evt.get('name', '')}': invalid callType='{ct}'")
                        ct_errors += 1

        for cmd in cmd_nodes:
            if stopped:
                break
            cmd_name = cmd.get("name", "")
            for action in cmd.findall(f"{{{F_NS}}}Action"):
                ct = action.get("callType", "")
                if ct:
                    ct_checked += 1
                    if ct not in valid_call_types:
                        report_error(f"Command '{cmd_name}' Action: invalid callType='{ct}'")
                        ct_errors += 1

        if not stopped and ct_errors == 0 and ct_checked > 0:
            report_ok(f"callType values: {ct_checked} checked")

        # 11c. Extension ID ranges
        base_attr_names = set()
        base_cmd_names = set()

        bf_attrs = base_form_node.find(f"{{{F_NS}}}Attributes")
        if bf_attrs is not None:
            for b_attr in bf_attrs.findall(f"{{{F_NS}}}Attribute"):
                ba_name = b_attr.get("name", "")
                if ba_name:
                    base_attr_names.add(ba_name)

        bf_cmds = base_form_node.find(f"{{{F_NS}}}Commands")
        if bf_cmds is not None:
            for b_cmd in bf_cmds.findall(f"{{{F_NS}}}Command"):
                bc_name = b_cmd.get("name", "")
                if bc_name:
                    base_cmd_names.add(bc_name)

        id_warn_count = 0
        for attr in attr_nodes:
            a_name = attr.get("name", "")
            a_id = attr.get("id", "")
            if a_name and a_name not in base_attr_names and a_id:
                try:
                    int_id = int(a_id)
                    if int_id < 1000000:
                        report_warn(f"Attribute '{a_name}' (id={a_id}): extension-added attribute has id < 1000000")
                        id_warn_count += 1
                except (ValueError, TypeError):
                    pass

        for cmd in cmd_nodes:
            c_name = cmd.get("name", "")
            c_id = cmd.get("id", "")
            if c_name and c_name not in base_cmd_names and c_id:
                try:
                    int_id = int(c_id)
                    if int_id < 1000000:
                        report_warn(f"Command '{c_name}' (id={c_id}): extension-added command has id < 1000000")
                        id_warn_count += 1
                except (ValueError, TypeError):
                    pass

        if not stopped and id_warn_count == 0:
            ext_attr_count = sum(1 for a in attr_nodes if a.get("name", "") not in base_attr_names)
            ext_cmd_count = sum(1 for c in cmd_nodes if c.get("name", "") not in base_cmd_names)
            if (ext_attr_count + ext_cmd_count) > 0:
                report_ok(f"Extension ID ranges: {ext_attr_count} attr(s), {ext_cmd_count} cmd(s) \u2014 all >= 1000000")

    # Check callType without BaseForm
    if not stopped and not is_extension:
        call_type_without_base = False
        fe_node = root.find(f"{{{F_NS}}}Events")
        if fe_node is not None:
            for evt in fe_node.findall(f"{{{F_NS}}}Event"):
                if evt.get("callType"):
                    call_type_without_base = True
                    break
        if not call_type_without_base:
            for cmd in cmd_nodes:
                for action in cmd.findall(f"{{{F_NS}}}Action"):
                    if action.get("callType"):
                        call_type_without_base = True
                        break
                if call_type_without_base:
                    break
        if call_type_without_base:
            report_warn("callType attributes found but no BaseForm \u2014 possible incorrect structure")

    # --- Check 12: Type validation ---
    if not stopped:
        type_nodes = root.xpath('//v8:Type', namespaces={'v8': V8_NS})
        type_error_count = 0
        type_warn_count = 0
        type_count = len(type_nodes)

        for tn in type_nodes:
            if stopped:
                break
            tv = (tn.text or "").strip()
            if not tv:
                continue

            if tv in KNOWN_INVALID_TYPES:
                report_error(f'12. Type "{tv}": invalid runtime/UI type (not valid in XDTO schema)')
                type_error_count += 1
            elif tv in VALID_CLOSED_TYPES:
                pass  # OK
            elif tv.startswith("cfg:"):
                suffix = tv[4:]  # after "cfg:"
                prefix = suffix.split(".")[0]
                if prefix in VALID_CFG_PREFIXES or suffix == "DynamicList":
                    # ExternalDataProcessorObject/ExternalReportObject valid only in EPF/ERF context
                    if is_config_context and prefix in ('ExternalDataProcessorObject', 'ExternalReportObject'):
                        report_error(f'12. Type "{tv}": External* type in configuration context (use DataProcessorObject/ReportObject instead)')
                        type_error_count += 1
                else:
                    report_warn(f'12. Type "{tv}": unrecognized cfg prefix')
                    type_warn_count += 1
            elif ":" in tv:
                pass  # unknown namespace, pass through
            else:
                report_warn(f'12. Type "{tv}": bare type without namespace prefix')
                type_warn_count += 1

        if type_error_count == 0 and type_warn_count == 0:
            if type_count > 0:
                report_ok(f'12. Types: {type_count} values, all valid')
            else:
                report_ok('12. Types: no type values to check')

    # --- Check 13: Form binding — имена из XML разрешаются в модуле формы ---
    #
    # Уровень Major без блокировки, и это измерено, а не предположено. Опыт на 8.3.27.1688
    # (файловая база, внешняя обработка, `ENTERPRISE /Execute`): форма с повисшей привязкой
    # на несрабатывающем событии открывается и работает ровно как контрольная — платформа не
    # разрешает привязки при создании формы. Дефект настоящий (XML называет процедуру,
    # которой нет ни в модуле формы, ни в модуле базовой), но он спит до наступления события,
    # и блокировать им коммит значило бы приравнять его к сломанной сборке.
    binding_ids = []
    binding_note = None
    if not stopped:
        module_path = os.path.join(os.path.dirname(os.path.abspath(form_path)), "Form", "Module.bsl")
        declared = module_declarations(module_path)
        base_declared, base_state = base_form_declarations(form_path)
        known = set(declared or set()) | set(base_declared)

        base_nodes = set()
        base_form_subtree = root.find(f"{{{F_NS}}}BaseForm")
        if base_form_subtree is not None:
            base_nodes = {id(node) for node in base_form_subtree.iter()}

        handler_missing = 0
        action_missing = 0
        binding_checked = 0

        def resolves(name):
            return normalize_name(name) in known

        for evt in root.iter(f"{{{F_NS}}}Event"):
            if id(evt) in base_nodes:
                continue
            handler = (evt.text or "").strip()
            if not handler:
                continue  # пустой обработчик — это Check 7, здесь не дублируем
            binding_checked += 1
            if declared is not None and not resolves(handler):
                report_warn(
                    f"[Binding] event '{evt.get('name', '')}': handler '{handler}' not found in form module"
                )
                handler_missing += 1

        for act in root.iter(f"{{{F_NS}}}Action"):
            if id(act) in base_nodes:
                continue
            action = (act.text or "").strip()
            if not action:
                continue  # пустое действие — это Check 8
            binding_checked += 1
            if declared is not None and not resolves(action):
                report_warn(f"[Binding] command action '{action}' not found in form module")
                action_missing += 1

        if handler_missing:
            binding_ids.append("qg:XML-FORM-HANDLER-MISSING")
        if action_missing:
            binding_ids.append("qg:XML-FORM-ACTION-MISSING")

        # Разные причины молчания различаются намеренно: модуля нет — проверять нечем;
        # основной конфигурации нет — имена базовой формы неразрешимы, и находка была бы
        # ложной. Оба случая заявляются, а не выдаются за чистый результат.
        if declared is None and binding_checked:
            binding_note = ("skipped", "form_module_absent")
        elif base_state == "no_main_configuration" and base_form_subtree is not None:
            binding_note = ("not_verified", "main_configuration_absent")

        if not binding_ids and binding_checked and declared is not None:
            report_ok(f"Form binding: {binding_checked} names resolved in form module")

    # --- Finalize ---
    checks = ok_count + errors + warnings
    if errors == 0 and warnings == 0 and not detailed:
        result = f"=== Validation OK: Form.{form_name} ({checks} checks) ==="
    else:
        output_lines.append("")
        output_lines.append(f"=== Result: {errors} errors, {warnings} warnings ({checks} checks) ===")
        result = "\n".join(output_lines)

    print(result)

    try:
        from _qg_journal import emit_evidence, record_run

        extra = []
        # Своё имя проверки, а не общее `structure-validation`: под тем именем в реестре
        # закреплён другой инструмент, и сверка покрытия закрывалась бы прогоном не того.
        #
        # Два вида молчания различаются намеренно. Отсутствие основной конфигурации —
        # измерение `cross-config-resolution` из закрытого списка: имена базовой формы
        # неразрешимы в принципе. Отсутствие модуля формы измерением не является вовсе, это
        # пропуск самой проверки; заяви его измерением — и запись закрывала бы утверждение о
        # разрешении имён, которого никто не делал.
        if binding_note:
            kind, reason = binding_note
            extra.append(
                f"[qg not_verified: dimension=cross-config-resolution, reason={reason}]"
                if kind == "not_verified"
                else f"[qg skipped: layer=xml, scope=form-binding, reason={reason}]"
            )
            # Прогон отмечается в любом исходе: инструмент отработал, и молчание об этом
            # неотличимо от строки, написанной вместо запуска.
            record_run(
                "form-binding",
                "tools/xml/form-validate.py",
                verdict=reason,
                files=[form_path],
            )
        else:
            ids = ",".join(binding_ids) if binding_ids else "qg:XML-FORM-HANDLER-MISSING,qg:XML-FORM-ACTION-MISSING"
            verdict = f"violation:{binding_ids[0]}" if binding_ids else "clean"
            extra.append(f"[qg applied: layer=xml, scope=form-binding, ids=[{ids}], verdict={verdict}]")
            record_run(
                "form-binding",
                "tools/xml/form-validate.py",
                verdict="violation" if binding_ids else "clean",
                files=[form_path],
            )
        emit_evidence("tools/xml/form-validate.py", errors, extra=extra)
    except ImportError:
        pass

    if errors > 0:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
