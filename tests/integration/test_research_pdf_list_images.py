"""Images in the first paragraph of list items must survive PDF rendering."""
from PIL import Image
from pypdf import PdfReader
import pytest
from reportlab.platypus import Image as PDFImage, Paragraph

from apps.api.app import research_pdf as pdf


@pytest.mark.parametrize("marker", ["-", "3."])
@pytest.mark.parametrize("body", ["![Chart](chart.png)", "Before ![Chart](chart.png) after", "![Chart](chart.png) after"])
def test_first_list_paragraph_embeds_images_and_keeps_text(tmp_path, marker, body):
    image = tmp_path / "chart.png"
    Image.new("RGB", (80, 40), "red").save(image)
    pdf._fonts()
    formatter = pdf._Content(lambda url: image)
    content = f"{marker} {body}\n"
    story = formatter.blocks(pdf._markdown(content))
    assert sum(isinstance(item, PDFImage) for item in story) == 1
    paragraphs = [item.getPlainText() for item in story if isinstance(item, Paragraph)]
    assert paragraphs[0].startswith("3." if marker == "3." else "•")
    assert sum("3." in text if marker == "3." else "•" in text for text in paragraphs) == 1
    assert "Chart" in paragraphs
    if "Before" in body:
        assert any("Before" in text for text in paragraphs)
    if "after" in body:
        assert any("after" in text for text in paragraphs)
    target = tmp_path / "list.pdf"
    pdf.render_document(target, title="List images", content=content, metadata={}, image_resolver=lambda url: image)
    reader = PdfReader(target)
    # The header logo appears on every page; the list's chart is another image.
    assert any(len(page.images) >= 2 for page in reader.pages)
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert "Chart" in text and "图：Chart" not in text


def test_list_missing_image_preserves_explicit_failure_label():
    pdf._fonts()
    formatter = pdf._Content()
    story = formatter.blocks(pdf._markdown("- Before ![Chart](missing.png) after"))
    text = " ".join(item.getPlainText() for item in story if isinstance(item, Paragraph))
    assert "Before" in text and "after" in text
    assert "图表未能嵌入" in text and "missing.png" in text
