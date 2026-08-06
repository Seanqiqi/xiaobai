# -*- coding: utf-8 -*-
# 从 docx 提取纯文本，输出 UTF-8 编码的 txt
import os, zipfile, re

d = os.path.dirname(os.path.abspath(__file__))
docx = os.path.join(d, '\u6587\u672c\u5185\u5bb9\u6574\u7406(2).docx')  # 文本内容整理(2).docx
dst = os.path.join(d, '\u6587\u672c\u5185\u5bb9_utf8.txt')              # 文本内容_utf8.txt

try:
    with zipfile.ZipFile(docx) as z:
        xml = z.read('word/document.xml').decode('utf-8')
    # 段落分隔，去掉所有 XML 标签
    text = re.sub(r'</w:p>', '\n', xml)
    text = re.sub(r'<[^>]+>', '', text)
    # 规整空行
    lines = [ln.strip() for ln in text.split('\n')]
    out = '\n'.join([ln for ln in lines if ln])
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(out)
    print('OK ->', os.path.basename(dst))
except Exception as e:
    print('Error:', e)
input('\u6309\u56de\u8f66\u952e\u9000\u51fa')  # 按回车键退出
