import qrcode from 'qrcode-generator';

export function QrCode(props: { text: string }) {
  const svg = () => {
    const qr = qrcode(0, 'M');
    qr.addData(props.text);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  };
  return <div class="qr" innerHTML={svg()} />;
}
