"""Tests for html/serialize.py."""

from bs4 import BeautifulSoup

from f5kb.html.serialize import is_hidden, make_serializer, node_to_markdown, resolve_url


def parse(html: str):
    return BeautifulSoup(html, "lxml")


def serialize(html: str, base_url: str | None = None) -> str:
    doc = parse(html)
    s = make_serializer(base_url)
    return s(doc.find("body") or doc)


def test_text_node_collapse_whitespace():
    doc = parse("<p>hello   world</p>")
    s = make_serializer()
    p = doc.find("p")
    assert "hello" in s(p)
    assert "world" in s(p)


def test_heading_levels():
    for i in range(1, 7):
        result = serialize(f"<h{i}>Title</h{i}>")
        assert "#" * i + " Title" in result


def test_link_with_href():
    result = serialize('<a href="https://example.com">Click</a>')
    assert "[Click](https://example.com)" in result


def test_link_no_href():
    result = serialize('<a>No href</a>')
    assert "No href" in result
    assert "[" not in result


def test_link_empty_text():
    result = serialize('<a href="https://example.com"></a>')
    assert "[" not in result


def test_image():
    result = serialize('<img src="img.png" alt="Alt text">')
    assert "![Alt text](img.png)" in result


def test_image_no_src():
    result = serialize('<img alt="Alt">')
    assert "![" not in result


def test_bold():
    result = serialize("<b>bold</b>")
    assert "**bold**" in result


def test_strong():
    result = serialize("<strong>strong</strong>")
    assert "**strong**" in result


def test_italic():
    result = serialize("<i>italic</i>")
    assert "*italic*" in result


def test_em():
    result = serialize("<em>em</em>")
    assert "*em*" in result


def test_inline_code():
    result = serialize("<code>func()</code>")
    assert "`func()`" in result


def test_pre_block():
    result = serialize("<pre>code block\nline2</pre>")
    assert "```" in result
    assert "code block" in result


def test_pre_empty():
    result = serialize("<pre>   </pre>")
    assert "```" not in result


def test_br():
    result = serialize("before<br>after")
    assert "\n" in result


def test_hr():
    result = serialize("<hr>")
    assert "---" in result


def test_list_items():
    result = serialize("<ul><li>item1</li><li>item2</li></ul>")
    assert "- item1" in result
    assert "- item2" in result


def test_script_stripped():
    result = serialize("<script>alert('xss')</script>text")
    assert "alert" not in result
    assert "text" in result


def test_style_stripped():
    result = serialize("<style>.foo{}</style>text")
    assert ".foo" not in result
    assert "text" in result


def test_noscript_stripped():
    result = serialize("<noscript>no js</noscript>text")
    assert "no js" not in result


def test_hidden_element_skipped():
    result = serialize('<div style="display:none">hidden</div>visible')
    assert "hidden" not in result
    assert "visible" in result


def test_resolve_url_relative():
    result = resolve_url("/path/to/page", "https://example.com/base/")
    assert result == "https://example.com/path/to/page"


def test_resolve_url_absolute():
    result = resolve_url("https://other.com/page", "https://example.com/base/")
    assert result == "https://other.com/page"


def test_resolve_url_no_base():
    assert resolve_url("/relative") == "/relative"


def test_p_div_section_double_newline():
    result = serialize("<p>para</p>")
    assert "para\n\n" in result


def test_blockquote():
    result = serialize("<blockquote>quoted</blockquote>")
    assert "> quoted" in result


def test_is_hidden_display_none():
    doc = parse('<div style="display:none">x</div>')
    el = doc.find("div")
    assert is_hidden(el) is True


def test_is_hidden_visible():
    doc = parse('<div style="color:red">x</div>')
    el = doc.find("div")
    assert is_hidden(el) is False


def test_node_to_markdown_alias():
    doc = parse("<p>test</p>")
    p = doc.find("p")
    result = node_to_markdown(p)
    assert "test" in result
